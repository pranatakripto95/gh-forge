// Ember Forge's server: one Node http server, three surfaces — git smart HTTP, REST v3,
// GraphQL v4 and MCP — on one in-memory store. The lifecycle (bind, register, wait for done)
// lives in main.ts and is not touched here.
//
// Wire discipline, on every reply: JSON for REST/GraphQL/MCP (never HTML), a non-empty
// X-GitHub-Request-Id, and the git surfaces' own content types. Auth is the one bearer
// token the trial sets (MAKEFUN_SHOP_TOKEN); when it is unset, any non-empty bearer is the
// viewer's, so the forge still runs standalone.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './lib/store.ts';
import { handleRest, type RestRequest } from './lib/rest.ts';
import { handleGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';
import {
  handleFetch,
  handleLsRefs,
  handleReceivePack,
  receivePackAdvertisement,
  uploadPackAdvertisement,
} from './lib/gitproto.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** The bearer token this request carries, or null when it carries none. */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  return match === null ? null : (match[1] as string);
}

/** Is this request the trial's viewer? (No token at all is never the viewer.) */
function isAuthenticated(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    'x-oauth-scopes': 'repo, read:org',
    ...extraHeaders,
  });
  res.end(payload);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
    'content-length': String(body.length),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function createApp(): Server {
  const store = new Store();
  return createServer((req, res) => {
    void (async () => {
      try {
        await route(store, req, res);
      } catch (err) {
        // The server never dies on a bad request: answer 500 JSON and stay up.
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    })();
  });
}

async function route(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const method = req.method ?? 'GET';
  const segments = url.pathname.split('/').filter((s) => s !== '').map(decodeSegment);

  // GET /healthz: the env's boot check. No auth, no store.
  if (method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}
  if (segments.length >= 2 && segments[1] !== undefined && segments[1].endsWith('.git')) {
    const owner = segments[0] as string;
    const repoName = (segments[1] as string).slice(0, -'.git'.length);
    const tail = segments.slice(2);
    if (!isAuthenticated(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (owner !== VIEWER_LOGIN) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const body = await readBody(req);
    if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
      const service = url.searchParams.get('service');
      if (service === 'git-upload-pack') {
        sendBytes(res, 200, uploadPackAdvertisement(repo), 'application/x-git-upload-pack-advertisement');
        return;
      }
      if (service === 'git-receive-pack') {
        sendBytes(res, 200, receivePackAdvertisement(repo), 'application/x-git-receive-pack-advertisement');
        return;
      }
      sendJson(res, 400, { message: 'Invalid service' });
      return;
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
      const text = body.subarray(0, 64).toString('utf8');
      if (text.includes('command=ls-refs')) {
        sendBytes(res, 200, handleLsRefs(repo, body), 'application/x-git-upload-pack-result');
        return;
      }
      if (text.includes('command=fetch')) {
        sendBytes(res, 200, handleFetch(store, repo, body), 'application/x-git-upload-pack-result');
        return;
      }
      sendJson(res, 400, { message: 'Unknown git-upload-pack command' });
      return;
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
      const result = handleReceivePack(store, repo, body);
      sendBytes(res, result.status, result.body, result.contentType);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // REST v3: /api/v3/...
  if (segments.length >= 1 && segments[0] === 'api' && segments[1] === 'v3') {
    if (!isAuthenticated(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const body = await readBody(req);
    let parsed: unknown = null;
    let malformed = false;
    if (body.length > 0) {
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        malformed = true;
      }
    }
    const restReq: RestRequest = {
      method,
      segments: segments.slice(2),
      query: url.searchParams,
      body: parsed,
      bodyMalformed: malformed,
    };
    const result = handleRest(store, restReq, `http://${req.headers.host ?? 'localhost'}${url.pathname}`);
    sendJson(res, result.status, result.body, result.headers ?? {});
    return;
  }

  // GraphQL v4: POST /api/graphql
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
    if (!isAuthenticated(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const body = await readBody(req);
    let parsed: unknown = null;
    let malformed = false;
    if (body.length > 0) {
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        malformed = true;
      }
    }
    const result = handleGraphQL(store, parsed, malformed);
    sendJson(res, result.status, result.body);
    return;
  }

  // MCP: POST /mcp (JSON-RPC 2.0 over streamable HTTP)
  if (segments.length === 1 && segments[0] === 'mcp') {
    if (!isAuthenticated(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const body = await readBody(req);
    const result = handleMcp(store, body);
    sendJson(res, result.status, result.body, result.headers ?? {});
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
