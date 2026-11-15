// Ember Forge's REST v3 surface: repositories, branches, commits, contents, labels, issues,
// pull requests and the wire discipline (JSON always, X-GitHub-Request-Id, Link pagination).
// The contract is the kit's sdk/conformance/checks-rest.ts; the shapes below are the fields
// those checks read, plus the usual GitHub fields a real client expects.

import { Store, VIEWER_LOGIN, VIEWER_ID, type Repo, type Issue, type Pull } from './store.ts';
import { isObjectId } from './gitobj.ts';

export interface RestResult {
  status: number;
  /** JSON value, or null for a bodyless reply (204). */
  body: unknown;
  headers?: Record<string, string>;
}

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3 (decoded). */
  segments: string[];
  query: URLSearchParams;
  /** Parsed JSON body, or null when there is none. */
  body: unknown;
  /** True when the request carried a body that was not valid JSON. */
  bodyMalformed: boolean;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const error = (status: number, message: string): RestResult => json(status, { message });
const notFound = (what = 'Not Found'): RestResult => error(404, what);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

function bodyBool(body: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = body[field];
  return typeof value === 'boolean' ? value : fallback;
}

/** GitHub's opaque global id for a node: base64 of a tagged string the node() query decodes. */
export function nodeId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

function userJson(login: string, id: number): Record<string, unknown> {
  return { login, id, node_id: nodeId('User', String(id)), type: 'User', site_admin: false };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: nodeId('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1000),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
  };
}

function labelJson(label: { name: string; color: string; description: string }): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    node_id: nodeId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return labelJson(label ?? { name, color: 'ededed', description: '' });
    }),
    user: userJson(issue.user, issue.user === VIEWER_LOGIN ? VIEWER_ID : 1000),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.id * 100000 + pull.number,
    node_id: nodeId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, repo: repoJson(repo) },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, repo: repoJson(repo) },
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    user: userJson(pull.user, pull.user === VIEWER_LOGIN ? VIEWER_ID : 1000),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** The repository a path names, or the 404 to answer when it is not this token's to read. */
function loadRepo(store: Store, owner: string, name: string): { repo: Repo } | { error: RestResult } {
  if (owner !== VIEWER_LOGIN) return { error: notFound('Not Found') };
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return { error: notFound('Not Found') };
  return { repo };
}

/** A page of a list, with GitHub's Link header when another page follows. */
function paginate<T>(items: readonly T[], query: URLSearchParams, baseUrl: string): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const link = (p: number, rel: string): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `<${baseUrl}?${q.toString()}>; rel="${rel}"`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(link(page + 1, 'next'), link(totalPages, 'last'));
  if (page > 1) parts.push(link(1, 'first'), link(page - 1, 'prev'));
  if (parts.length > 0) headers.link = parts.join(', ');
  return { page: [...slice], headers };
}

/** Resolve a ref name (branch, tag, or sha) to a commit id, or undefined. */
function resolveRef(store: Store, repo: Repo, ref: string | null): string | undefined {
  if (ref === null || ref === '') return store.headSha(repo);
  if (isObjectId(ref)) return repo.objects.has(ref) ? ref : undefined;
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return direct;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return tag;
  return undefined;
}

/** The REST v3 router. `baseUrl` is the request's absolute URL (origin + path, no query), for Link headers. */
export function handleRest(store: Store, req: RestRequest, baseUrl: string): RestResult {
  const [a, b, c, d, e, f] = req.segments;
  const method = req.method;
  if (req.bodyMalformed) return error(400, 'Problems parsing JSON');

  // GET /api/v3/
  if (req.segments.length === 0) {
    if (method !== 'GET') return error(405, 'Method Not Allowed');
    return json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (a === 'meta' && req.segments.length === 1) {
    if (method !== 'GET') return error(405, 'Method Not Allowed');
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }
  if (a === 'user' && req.segments.length === 1) {
    if (method !== 'GET') return error(405, 'Method Not Allowed');
    return json(200, { ...userJson(VIEWER_LOGIN, VIEWER_ID), name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid` });
  }
  // POST /api/v3/user/repos, GET /api/v3/user/repos
  if (a === 'user' && b === 'repos' && req.segments.length === 2) {
    if (method === 'POST') {
      if (!isObject(req.body)) return error(422, 'Validation Failed');
      const name = bodyString(req.body, 'name');
      if (name === '') return error(422, 'Validation Failed: name is required');
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) return error(422, 'Repository already exists');
      const repo = store.createRepo(VIEWER_LOGIN, name, {
        description: bodyString(req.body, 'description'),
        private: bodyBool(req.body, 'private', false),
        defaultBranch: bodyString(req.body, 'default_branch') || undefined,
      });
      return json(201, repoJson(repo));
    }
    if (method === 'GET') {
      const repos = store.listRepos(VIEWER_LOGIN);
      const { page, headers } = paginate(repos.map((r) => repoJson(r)), req.query, baseUrl);
      return json(200, page, headers);
    }
    return error(405, 'Method Not Allowed');
  }

  // /api/v3/repos/{owner}/{name}/...
  if (a === 'repos' && b !== undefined && c !== undefined) {
    const loaded = loadRepo(store, b, c);
    if ('error' in loaded) return loaded.error;
    const repo = loaded.repo;
    const rest = req.segments.slice(3);
    // GET/PATCH/DELETE /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') return json(200, repoJson(repo));
      if (method === 'PATCH') {
        if (!isObject(req.body)) return error(422, 'Validation Failed');
        if (typeof req.body.description === 'string') repo.description = req.body.description;
        if (typeof req.body.default_branch === 'string' && req.body.default_branch !== '') {
          repo.defaultBranch = req.body.default_branch;
        }
        if (typeof req.body.private === 'boolean') repo.private = req.body.private;
        repo.updatedAt = store.nowIso();
        return json(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo.owner, repo.name);
        return { status: 204, body: null };
      }
      return error(405, 'Method Not Allowed');
    }
    const [r1, r2, r3] = rest;
    // branches
    if (r1 === 'branches' && rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` }, protected: false }));
      branches.sort((x, y) => (x.name < y.name ? -1 : 1));
      return json(200, branches);
    }
    // git/refs
    if (r1 === 'git' && r2 === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        if (!isObject(req.body)) return error(422, 'Validation Failed');
        const ref = bodyString(req.body, 'ref');
        const sha = bodyString(req.body, 'sha');
        if (ref === '' || !isObjectId(sha) || !repo.objects.has(sha)) return error(422, 'Validation Failed');
        if (repo.refs.has(ref)) return error(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        return json(201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' }, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace(/^refs\//, '')}` });
      }
      if (method === 'GET') {
        const refs = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
        refs.sort((x, y) => (x.ref < y.ref ? -1 : 1));
        return json(200, refs);
      }
      return error(405, 'Method Not Allowed');
    }
    // commits
    if (r1 === 'commits') {
      if (method === 'GET' && rest.length === 1) {
        const tip = resolveRef(store, repo, req.query.get('sha'));
        if (tip === undefined) return json(200, []);
        const history = store.commitHistory(repo, tip);
        const commits = history.map((sha) => {
          const info = store.commitInfo(repo, sha);
          return {
            sha,
            commit: {
              message: info?.message ?? '',
              author: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: repo.createdAt },
              committer: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: repo.createdAt },
              tree: { sha: info?.tree ?? '' },
            },
            parents: (info?.parents ?? []).map((p) => ({ sha: p })),
            url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
          };
        });
        const { page, headers } = paginate(commits, req.query, baseUrl);
        return json(200, page, headers);
      }
      if (method === 'GET' && rest.length === 2 && r2 !== undefined && isObjectId(r2)) {
        const info = store.commitInfo(repo, r2);
        if (info === undefined) return notFound('Not Found');
        return json(200, {
          sha: r2,
          commit: { message: info.message, author: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid` }, committer: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid` }, tree: { sha: info.tree } },
          parents: info.parents.map((p) => ({ sha: p })),
        });
      }
      return error(405, 'Method Not Allowed');
    }
    // contents
    if (r1 === 'contents') {
      const filePath = rest.slice(1).join('/');
      if (method === 'PUT') return putContents(store, repo, filePath, req);
      if (method === 'GET') return getContents(store, repo, filePath, req);
      if (method === 'DELETE') return deleteContents(store, repo, filePath, req);
      return error(405, 'Method Not Allowed');
    }
    // labels
    if (r1 === 'labels') {
      if (rest.length === 1 && method === 'GET') {
        return json(200, [...repo.labels.values()].map((l) => labelJson(l)));
      }
      if (rest.length === 1 && method === 'POST') {
        if (!isObject(req.body)) return error(422, 'Validation Failed');
        const name = bodyString(req.body, 'name');
        if (name === '') return error(422, 'Validation Failed: name is required');
        if (repo.labels.has(name)) return error(422, 'Label already exists');
        const label = { name, color: bodyString(req.body, 'color') || 'ededed', description: bodyString(req.body, 'description') };
        repo.labels.set(name, label);
        return json(201, labelJson(label));
      }
      return error(405, 'Method Not Allowed');
    }
    // issues
    if (r1 === 'issues') {
      if (rest.length === 1 && method === 'POST') return createIssue(store, repo, req);
      if (rest.length === 1 && method === 'GET') return listIssues(store, repo, req, baseUrl);
      if (rest.length === 2 && r2 !== undefined && /^\d+$/.test(r2)) {
        const number = Number(r2);
        const issue = repo.issues.find((i) => i.number === number);
        if (issue === undefined) return notFound('Not Found');
        if (method === 'GET') return json(200, issueJson(repo, issue));
        if (method === 'PATCH') {
          if (!isObject(req.body)) return error(422, 'Validation Failed');
          if (typeof req.body.title === 'string') issue.title = req.body.title;
          if (typeof req.body.body === 'string') issue.body = req.body.body;
          if (req.body.state === 'open' || req.body.state === 'closed') {
            issue.state = req.body.state;
            issue.closedAt = req.body.state === 'closed' ? store.nowIso() : null;
          }
          if (Array.isArray(req.body.labels)) {
            const names = req.body.labels.filter((l): l is string => typeof l === 'string');
            for (const name of names) if (!repo.labels.has(name)) return error(422, `Validation Failed: label ${name} does not exist`);
            issue.labels = names;
          }
          issue.updatedAt = store.nowIso();
          return json(200, issueJson(repo, issue));
        }
        return error(405, 'Method Not Allowed');
      }
      if (rest.length === 3 && r2 !== undefined && /^\d+$/.test(r2) && r3 === 'comments') {
        const number = Number(r2);
        const issue = repo.issues.find((i) => i.number === number);
        if (issue === undefined) return notFound('Not Found');
        if (method === 'POST') {
          if (!isObject(req.body)) return error(422, 'Validation Failed');
          const body = bodyString(req.body, 'body');
          if (body === '') return error(422, 'Validation Failed: body is required');
          const now = store.nowIso();
          const comment: Issue['comments'][number] = { id: repo.nextComment, body, user: VIEWER_LOGIN, createdAt: now, updatedAt: now };
          repo.nextComment += 1;
          issue.comments.push(comment);
          return json(201, { id: comment.id, body: comment.body, user: userJson(VIEWER_LOGIN, VIEWER_ID), created_at: now, updated_at: now, html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${number}#issuecomment-${comment.id}` });
        }
        if (method === 'GET') {
          return json(200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: userJson(VIEWER_LOGIN, VIEWER_ID), created_at: comment.createdAt, updated_at: comment.updatedAt })));
        }
        return error(405, 'Method Not Allowed');
      }
      return notFound('Not Found');
    }
    // pulls
    if (r1 === 'pulls') {
      if (rest.length === 1 && method === 'POST') return createPull(store, repo, req);
      if (rest.length === 1 && method === 'GET') return listPulls(store, repo, req, baseUrl);
      if (rest.length === 2 && r2 !== undefined && /^\d+$/.test(r2)) {
        const number = Number(r2);
        const pull = repo.pulls.find((p) => p.number === number);
        if (pull === undefined) return notFound('Not Found');
        if (method === 'GET') return json(200, pullJson(repo, pull));
        return error(405, 'Method Not Allowed');
      }
      if (rest.length === 3 && r2 !== undefined && /^\d+$/.test(r2) && r3 === 'files') {
        const number = Number(r2);
        const pull = repo.pulls.find((p) => p.number === number);
        if (pull === undefined) return notFound('Not Found');
        const baseInfo = store.commitInfo(repo, pull.baseSha);
        const headInfo = store.commitInfo(repo, pull.headSha);
        if (baseInfo === undefined || headInfo === undefined) return json(200, []);
        const files = store.diffTrees(repo, baseInfo.tree, headInfo.tree);
        return json(200, files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes, sha: f.newSha ?? f.oldSha ?? '', patch: '' })));
      }
      if (rest.length === 3 && r2 !== undefined && /^\d+$/.test(r2) && r3 === 'merge') {
        const number = Number(r2);
        const pull = repo.pulls.find((p) => p.number === number);
        if (pull === undefined) return notFound('Not Found');
        if (method !== 'PUT') return error(405, 'Method Not Allowed');
        return mergePull(store, repo, pull);
      }
      return notFound('Not Found');
    }
    return notFound('Not Found');
  }
  return notFound('Not Found');
}

// ---------------------------------------------------------------- contents

function putContents(store: Store, repo: Repo, filePath: string, req: RestRequest): RestResult {
  if (!isObject(req.body)) return error(422, 'Validation Failed');
  const message = bodyString(req.body, 'message');
  const contentB64 = bodyString(req.body, 'content');
  if (message === '' || contentB64 === '') return error(422, 'Validation Failed');
  const branch = bodyString(req.body, 'branch') || repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  const baseTree = tip === undefined ? null : store.commitInfo(repo, tip)?.tree ?? null;
  const paths = baseTree === null ? new Map() : store.treePaths(repo, baseTree);
  const existing = paths.get(filePath);
  const givenSha = bodyString(req.body, 'sha');
  if (existing !== undefined) {
    if (givenSha === '') return error(422, 'Validation Failed: sha is required to update a file');
    if (givenSha.toLowerCase() !== existing.sha.toLowerCase()) return error(409, 'Conflict: sha does not match the current file');
  } else if (givenSha !== '') {
    return error(409, 'Conflict: sha given for a file that does not exist');
  }
  let content: Buffer;
  try {
    content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    return error(422, 'Validation Failed: content is not valid base64');
  }
  const changes = new Map<string, { mode: string; data: Buffer } | null>();
  changes.set(filePath, { mode: '100644', data: content });
  const newTree = store.buildTree(repo, baseTree, changes);
  const blobSha = store.putBlob(repo, content);
  const commitSha = store.createCommit(repo, { tree: newTree, parents: tip === undefined ? [] : [tip], message });
  repo.refs.set(refName, commitSha);
  repo.updatedAt = store.nowIso();
  return json(existing === undefined ? 201 : 200, {
    content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: blobSha, size: content.length, type: 'file', encoding: 'base64', content: contentB64 },
    commit: { sha: commitSha, message },
  });
}

function getContents(store: Store, repo: Repo, filePath: string, req: RestRequest): RestResult {
  const tip = resolveRef(store, repo, req.query.get('ref'));
  if (tip === undefined) return notFound('Not Found');
  const info = store.commitInfo(repo, tip);
  if (info === undefined) return notFound('Not Found');
  const paths = store.treePaths(repo, info.tree);
  const entry = paths.get(filePath);
  if (entry !== undefined) {
    const blob = repo.objects.get(entry.sha);
    if (blob === undefined || blob.type !== 'blob') return notFound('Not Found');
    return json(200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: filePath.split('/').pop() ?? filePath,
      path: filePath,
      content: blob.data.toString('base64'),
      sha: entry.sha,
    });
  }
  // A directory: list its immediate children.
  const prefix = filePath === '' ? '' : `${filePath}/`;
  const children = new Map<string, { type: 'file' | 'dir'; sha: string; size: number }>();
  for (const [path, value] of paths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const blob = repo.objects.get(value.sha);
      children.set(rest, { type: 'file', sha: value.sha, size: blob?.type === 'blob' ? blob.data.length : 0 });
    } else {
      children.set(rest.slice(0, slash), { type: 'dir', sha: '', size: 0 });
    }
  }
  if (children.size === 0) return notFound('Not Found');
  const listing = [...children.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, child]) => ({ type: child.type, name, path: `${prefix}${name}`, sha: child.sha, size: child.size }));
  return json(200, listing);
}

function deleteContents(store: Store, repo: Repo, filePath: string, req: RestRequest): RestResult {
  if (!isObject(req.body)) return error(422, 'Validation Failed');
  const message = bodyString(req.body, 'message');
  const givenSha = bodyString(req.body, 'sha');
  if (message === '' || givenSha === '') return error(422, 'Validation Failed');
  const branch = bodyString(req.body, 'branch') || repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  if (tip === undefined) return notFound('Not Found');
  const info = store.commitInfo(repo, tip);
  if (info === undefined) return notFound('Not Found');
  const paths = store.treePaths(repo, info.tree);
  const existing = paths.get(filePath);
  if (existing === undefined) return notFound('Not Found');
  if (givenSha.toLowerCase() !== existing.sha.toLowerCase()) return error(409, 'Conflict: sha does not match the current file');
  const changes = new Map<string, { mode: string; data: Buffer } | null>();
  changes.set(filePath, null);
  const newTree = store.buildTree(repo, info.tree, changes);
  const commitSha = store.createCommit(repo, { tree: newTree, parents: [tip], message });
  repo.refs.set(refName, commitSha);
  repo.updatedAt = store.nowIso();
  return json(200, { content: null, commit: { sha: commitSha, message } });
}

// ---------------------------------------------------------------- issues

function createIssue(store: Store, repo: Repo, req: RestRequest): RestResult {
  if (!isObject(req.body)) return error(422, 'Validation Failed');
  const title = bodyString(req.body, 'title');
  if (title === '') return error(422, 'Validation Failed: title is required');
  const body = bodyString(req.body, 'body');
  const labels = Array.isArray(req.body.labels) ? req.body.labels.filter((l): l is string => typeof l === 'string') : [];
  for (const name of labels) if (!repo.labels.has(name)) return error(422, `Validation Failed: label ${name} does not exist`);
  const now = store.nowIso();
  const issue: Issue = {
    id: repo.id * 100000 + repo.nextIssue,
    number: repo.nextIssue,
    title,
    body,
    state: 'open',
    labels,
    user: VIEWER_LOGIN,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: [],
  };
  repo.nextIssue += 1;
  repo.issues.push(issue);
  return json(201, issueJson(repo, issue));
}

function listIssues(store: Store, repo: Repo, req: RestRequest, baseUrl: string): RestResult {
  const state = req.query.get('state') ?? 'open';
  const sort = req.query.get('sort') ?? 'created';
  const direction = req.query.get('direction') ?? 'desc';
  let issues = [...repo.issues];
  if (state !== 'all') issues = issues.filter((i) => i.state === state);
  if (sort === 'created') {
    issues.sort((a, b) => (direction === 'asc' ? (a.createdAt < b.createdAt ? -1 : 1) : a.createdAt > b.createdAt ? -1 : 1));
  }
  const { page, headers } = paginate(issues.map((i) => issueJson(repo, i)), req.query, baseUrl);
  return json(200, page, headers);
}

// ---------------------------------------------------------------- pulls

function createPull(store: Store, repo: Repo, req: RestRequest): RestResult {
  if (!isObject(req.body)) return error(422, 'Validation Failed');
  const title = bodyString(req.body, 'title');
  const head = bodyString(req.body, 'head');
  const base = bodyString(req.body, 'base');
  if (title === '' || head === '' || base === '') return error(422, 'Validation Failed');
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined || baseSha === undefined) return error(422, 'Validation Failed: head or base branch does not exist');
  const now = store.nowIso();
  const pull: Pull = {
    id: repo.id * 100000 + repo.nextPull,
    number: repo.nextPull,
    title,
    body: bodyString(req.body, 'body'),
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    merged: false,
    mergeCommitSha: null,
    mergedAt: null,
    user: VIEWER_LOGIN,
    createdAt: now,
    updatedAt: now,
  };
  repo.nextPull += 1;
  repo.pulls.push(pull);
  return json(201, pullJson(repo, pull));
}

function listPulls(store: Store, repo: Repo, req: RestRequest, baseUrl: string): RestResult {
  const state = req.query.get('state') ?? 'open';
  let pulls = [...repo.pulls];
  if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
  pulls.sort((a, b) => b.number - a.number);
  const { page, headers } = paginate(pulls.map((p) => pullJson(repo, p)), req.query, baseUrl);
  return json(200, page, headers);
}

function mergePull(store: Store, repo: Repo, pull: Pull): RestResult {
  if (pull.state !== 'open' || pull.merged) return error(405, 'Pull request is not open');
  const baseRef = `refs/heads/${pull.baseRef}`;
  const baseTip = repo.refs.get(baseRef);
  if (baseTip === undefined) return error(405, 'Base branch does not exist');
  const headInfo = store.commitInfo(repo, pull.headSha);
  if (headInfo === undefined) return error(405, 'Head commit does not exist');
  if (store.mergeConflicts(repo, baseTip, pull.headSha)) return error(405, 'Merge conflict');
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
  const mergeSha = store.createCommit(repo, { tree: headInfo.tree, parents: [baseTip], message });
  repo.refs.set(baseRef, mergeSha);
  const now = store.nowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = mergeSha;
  pull.mergedAt = now;
  pull.updatedAt = now;
  repo.updatedAt = now;
  return json(200, { sha: mergeSha, merged: true, message });
}
