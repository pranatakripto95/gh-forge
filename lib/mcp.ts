// Ember Forge's MCP surface: JSON-RPC 2.0 over streamable HTTP (plain JSON answers), speaking
// both the 2026-07-28 revision (server/discover, no session) and the older handshake
// (initialize + notifications/initialized, with a Mcp-Session-Id). The six tools act on the
// same store as REST, so an object created over MCP is the same object over REST.
//
// The contract is the kit's sdk/conformance/checks-mcp.ts: tools/list is byte-identical across
// calls (the tool table is a constant), an unknown tool is -32602, a body that is not JSON is
// HTTP 400 with -32700, and a call missing its required arguments answers isError:true.

import { Store, VIEWER_LOGIN, VIEWER_ID } from './store.ts';

const SERVER_NAME = 'ember-forge';
const SERVER_VERSION = '1.0.0';
const SESSION_ID = 'ember-forge-1';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner (the viewer).' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      },
      required: ['owner', 'repo'],
    },
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List a repository issues, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  }),
]);

export interface McpResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function textResult(text: string, structured: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text }], structuredContent: structured, isError: false };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Owner + repo out of a tool's arguments (full_name splits when repo is absent). */
function repoTarget(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if (repo === '' && typeof args.full_name === 'string') {
    const [o, r] = (args.full_name as string).split('/', 2);
    if (o !== undefined && r !== undefined) {
      owner = o;
      repo = r;
    }
  }
  return { owner, repo };
}

function missing(args: Record<string, unknown>, required: readonly string[]): string[] {
  return required.filter((name) => args[name] === undefined || args[name] === '');
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) return { __rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  const required = (tool.inputSchema.required as string[]) ?? [];
  const absent = missing(args, required);
  if (absent.length > 0) return errorResult(`Missing required argument(s): ${absent.join(', ')}`);

  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) return errorResult('Repository already exists');
      const repo = store.createRepo(VIEWER_LOGIN, repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      const out = { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: repo.owner, private: repo.private, description: repo.description, default_branch: repo.defaultBranch };
      return textResult(JSON.stringify(out), out);
    }
    case 'get_repo': {
      const { owner, repo: repoName } = repoTarget(args);
      if (owner !== VIEWER_LOGIN) return errorResult('Repository not found');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult('Repository not found');
      const out = { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: repo.owner, private: repo.private, description: repo.description, default_branch: repo.defaultBranch };
      return textResult(JSON.stringify(out), out);
    }
    case 'create_issue': {
      const { owner, repo: repoName } = repoTarget(args);
      if (owner !== VIEWER_LOGIN) return errorResult('Repository not found');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult('Repository not found');
      const now = store.nowIso();
      const issue = {
        id: repo.id * 100000 + repo.nextIssue,
        number: repo.nextIssue,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [] as string[],
        user: VIEWER_LOGIN,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        comments: [] as never[],
      };
      repo.nextIssue += 1;
      repo.issues.push(issue);
      const out = { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state };
      return textResult(JSON.stringify(out), out);
    }
    case 'list_issues': {
      const { owner, repo: repoName } = repoTarget(args);
      if (owner !== VIEWER_LOGIN) return errorResult('Repository not found');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult('Repository not found');
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const issues = repo.issues.filter((i) => state === 'all' || i.state === state);
      const out = issues.map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state }));
      return textResult(JSON.stringify(out), { issues: out });
    }
    case 'create_pull_request': {
      const { owner, repo: repoName } = repoTarget(args);
      if (owner !== VIEWER_LOGIN) return errorResult('Repository not found');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult('Repository not found');
      const head = String(args.head);
      const base = String(args.base);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return errorResult('Head or base branch does not exist');
      const now = store.nowIso();
      const pull = {
        id: repo.id * 100000 + repo.nextPull,
        number: repo.nextPull,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        merged: false,
        mergeCommitSha: null as string | null,
        mergedAt: null as string | null,
        user: VIEWER_LOGIN,
        createdAt: now,
        updatedAt: now,
      };
      repo.nextPull += 1;
      repo.pulls.push(pull);
      const out = { id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: 'OPEN', head, base, head_ref: head, base_ref: base };
      return textResult(JSON.stringify(out), out);
    }
    case 'merge_pull_request': {
      const { owner, repo: repoName } = repoTarget(args);
      if (owner !== VIEWER_LOGIN) return errorResult('Repository not found');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult('Repository not found');
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) return errorResult('Pull request not found');
      if (pull.state !== 'open' || pull.merged) return errorResult('Pull request is not open');
      const baseRef = `refs/heads/${pull.baseRef}`;
      const baseTip = repo.refs.get(baseRef);
      if (baseTip === undefined) return errorResult('Base branch does not exist');
      const headInfo = store.commitInfo(repo, pull.headSha);
      if (headInfo === undefined || store.mergeConflicts(repo, baseTip, pull.headSha)) return errorResult('Merge conflict');
      const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
      const mergeSha = store.createCommit(repo, { tree: headInfo.tree, parents: [baseTip], message });
      repo.refs.set(baseRef, mergeSha);
      const now = store.nowIso();
      pull.state = 'closed';
      pull.merged = true;
      pull.mergeCommitSha = mergeSha;
      pull.mergedAt = now;
      pull.updatedAt = now;
      const out = { number: pull.number, merged: true, sha: mergeSha, state: 'closed' };
      return textResult(JSON.stringify(out), out);
    }
    default:
      return { __rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** POST /mcp: one JSON-RPC request (or a notification, which answers 202). */
export function handleMcp(store: Store, body: Buffer): McpResult {
  const headers: Record<string, string> = { 'mcp-session-id': SESSION_ID };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error'), headers };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request'), headers };
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  // A notification (no id) is acknowledged and nothing more.
  if (id === null && method !== '') {
    return { status: 202, body: {}, headers };
  }

  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        body: rpcResult(id, {
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          capabilities: { tools: {} },
          supportedVersions: SUPPORTED_VERSIONS,
          protocolVersion: SUPPORTED_VERSIONS[0],
        }),
        headers,
      };
    case 'initialize': {
      const wanted = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(wanted) ? wanted : (SUPPORTED_VERSIONS[0] as string);
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
        headers,
      };
    }
    case 'tools/list':
      return { status: 200, body: rpcResult(id, { tools: TOOLS }), headers };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const result = callTool(store, name, args);
      if ('__rpcError' in result) {
        const rpcErr = result.__rpcError as { code: number; message: string };
        return { status: 200, body: rpcError(id, rpcErr.code, rpcErr.message), headers };
      }
      return { status: 200, body: rpcResult(id, result), headers };
    }
    case 'ping':
      return { status: 200, body: rpcResult(id, {}), headers };
    default:
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`), headers };
  }
}
