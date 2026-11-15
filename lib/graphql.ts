// Ember Forge's GraphQL v4 surface: a small executor for the documents gh and
// github-mcp-server actually send (the kit's sdk/conformance/checks-graphql.ts lists all 18),
// plus __type introspection for the types they probe. It is a targeted executor, not a full
// GraphQL engine: it parses the query/mutation documents the suite sends — fields, arguments,
// variables, aliases, inline fragments — and resolves them against the same store as REST.
//
// Conventions that matter: GraphQL states are OPEN/CLOSED (REST's are open/closed); a
// repository that does not exist reads `repository: null` with NO error; an unknown field is
// an HTTP 200 with an errors array naming it; a batched body (an array of operations) answers
// an array of results in order.

import { Store, VIEWER_LOGIN, VIEWER_ID, type Issue, type Pull, type Repo } from './store.ts';
import { nodeId } from './rest.ts';

// ---------------------------------------------------------------- parsing

type Value = string | number | boolean | null | Value[] | { [key: string]: Value };

interface Selection {
  kind: 'field' | 'fragment';
  name: string;
  alias: string | null;
  args: Record<string, Value>;
  selections: Selection[];
  typeCondition: string | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, string>;
  selections: Selection[];
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if ('{}():$!=@[]'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*|^-?\d+(\.\d+)?/.exec(input.slice(i));
    if (match === null) throw new Error(`GraphQL parse error at ${JSON.stringify(input.slice(i, i + 12))}`);
    tokens.push(match[0]);
    i += match[0].length;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string {
    return this.tokens[this.pos] ?? '';
  }

  private next(): string {
    const token = this.tokens[this.pos] ?? '';
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    if (this.next() !== token) throw new Error(`GraphQL parse error: expected ${token}`);
  }

  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const first = this.peek();
    if (first === 'query' || first === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
      const maybeName = this.peek();
      if (maybeName !== '' && maybeName !== '(' && maybeName !== '{') name = this.next();
    }
    const variables: Record<string, string> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.peek() !== '') {
        if (this.peek() === '$') {
          this.next();
          const varName = this.next();
          this.expect(':');
          const typeName = this.next();
          variables[varName] = typeName;
          if (this.peek() === '!') this.next();
          if (this.peek() === '=') {
            this.next();
            this.parseValue();
          }
        } else {
          this.next();
        }
      }
      this.expect(')');
    }
    const selections = this.parseSelections();
    return { kind, name, variables, selections };
  }

  parseSelections(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek() !== '}' && this.peek() !== '') {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  parseSelection(): Selection {
    if (this.peek() === '...') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        typeCondition = this.next();
      } else {
        // A named fragment spread: the suite never sends one; skip its selections.
        this.next();
        return { kind: 'fragment', name: '', alias: null, args: {}, selections: [], typeCondition: null };
      }
      return { kind: 'fragment', name: '', alias: null, args: {}, selections: this.parseSelections(), typeCondition };
    }
    const first = this.next();
    let alias: string | null = null;
    let name = first;
    if (this.peek() === ':') {
      this.next();
      alias = first;
      name = this.next();
    }
    const args: Record<string, Value> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.peek() !== '') {
        const argName = this.next();
        this.expect(':');
        args[argName] = this.parseValue();
        if (this.peek() === ',') this.next();
      }
      this.expect(')');
    }
    const selections = this.peek() === '{' ? this.parseSelections() : [];
    return { kind: 'field', name, alias, args, selections, typeCondition: null };
  }

  parseValue(): Value {
    const token = this.next();
    if (token === '$') return { $var: this.next() } as unknown as Value;
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']' && this.peek() !== '') {
        items.push(this.parseValue());
        if (this.peek() === ',') this.next();
      }
      this.expect(']');
      return items;
    }
    if (token === '{') {
      const obj: Record<string, Value> = {};
      while (this.peek() !== '}' && this.peek() !== '') {
        const key = this.next();
        this.expect(':');
        obj[key] = this.parseValue();
        if (this.peek() === ',') this.next();
      }
      this.expect('}');
      return obj;
    }
    if (token.startsWith('"')) return JSON.parse(token) as string;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    const num = Number(token);
    if (token !== '' && !Number.isNaN(num)) return num;
    return token;
  }
}

/** Substitute $variables in a parsed argument value. */
function substitute(value: Value, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if ('$var' in record) return variables[record.$var as string];
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) out[k] = substitute(v as Value, variables);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, variables));
  return value;
}

// ---------------------------------------------------------------- schema (for __type)

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'url', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'url', 'isPrivate'],
  User: ['id', 'login', 'name', 'email', 'url'],
  SearchType: [],
};
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'PACKAGE', 'WIKI', 'PROJECT'];

// ---------------------------------------------------------------- resolving

interface Ctx {
  store: Store;
  errors: Array<{ message: string }>;
}

function decodeNodeId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function findRepoByNodeId(store: Store, id: string): Repo | null {
  const decoded = decodeNodeId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const numeric = Number(decoded.key);
  if (!Number.isInteger(numeric)) return null;
  for (const repo of store.repos.values()) if (repo.id === numeric) return repo;
  return null;
}

function findIssueByNodeId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeNodeId(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const [repoId, number] = decoded.key.split(':');
  const repo = [...store.repos.values()].find((r) => r.id === Number(repoId));
  if (repo === undefined) return null;
  const issue = repo.issues.find((i) => i.number === Number(number));
  return issue === undefined ? null : { repo, issue };
}

function findPullByNodeId(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeNodeId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const [repoId, number] = decoded.key.split(':');
  const repo = [...store.repos.values()].find((r) => r.id === Number(repoId));
  if (repo === undefined) return null;
  const pull = repo.pulls.find((p) => p.number === Number(number));
  return pull === undefined ? null : { repo, pull };
}

function gqlState(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueNode(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue',
    __repo: repo,
    __issue: issue,
    id: nodeId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: gqlState(issue.state),
  };
}

function pullNode(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    __typename: 'PullRequest',
    __repo: repo,
    __pull: pull,
    id: nodeId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: gqlState(pull.state),
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
  };
}

function repoNode(repo: Repo): Record<string, unknown> {
  return {
    __typename: 'Repository',
    __repo: repo,
    id: nodeId('Repository', String(repo.id)),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    viewerPermission: 'WRITE',
    hasIssuesEnabled: true,
    description: repo.description,
    isPrivate: repo.private,
  };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string | null): number | null {
  if (cursor === null) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

/** Resolve one field of a node; returns undefined when the field is not in the schema. */
function resolveField(ctx: Ctx, node: Record<string, unknown>, sel: Selection, variables: Record<string, unknown>): unknown {
  const type = (node.__typename as string) ?? 'Query';
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sel.args)) args[k] = substitute(v, variables);
  const repo = node.__repo as Repo | undefined;
  const issue = node.__issue as Issue | undefined;
  const pull = node.__pull as Pull | undefined;

  switch (type) {
    case 'Query': {
      if (sel.name === 'viewer') return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID };
      if (sel.name === 'repository') {
        const owner = args.owner as string;
        const name = args.name as string;
        if (owner !== VIEWER_LOGIN) return null;
        const found = ctx.store.getRepo(owner, name);
        return found === undefined ? null : repoNode(found);
      }
      if (sel.name === 'node') {
        const id = args.id as string;
        const byRepo = findRepoByNodeId(ctx.store, id);
        if (byRepo !== null) return repoNode(byRepo);
        const byIssue = findIssueByNodeId(ctx.store, id);
        if (byIssue !== null) return issueNode(byIssue.repo, byIssue.issue);
        const byPull = findPullByNodeId(ctx.store, id);
        if (byPull !== null) return pullNode(byPull.repo, byPull.pull);
        return null;
      }
      if (sel.name === '__type') {
        const name = args.name as string;
        if (name === 'SearchType') return { __typename: '__Type', name, enumValues: SEARCH_TYPE_VALUES.map((v) => ({ name: v })) };
        const fields = TYPE_FIELDS[name];
        if (fields === undefined) return null;
        return { __typename: '__Type', name, fields: fields.map((f) => ({ name: f })) };
      }
      if (sel.name === '__schema') return { __typename: '__Schema', queryType: { name: 'Query' } };
      return undefined;
    }
    case 'Mutation': {
      const input = (args.input ?? {}) as Record<string, unknown>;
      if (sel.name === 'createIssue') return mutationCreateIssue(ctx, input);
      if (sel.name === 'closeIssue') return mutationCloseIssue(ctx, input);
      if (sel.name === 'createPullRequest') return mutationCreatePullRequest(ctx, input);
      if (sel.name === 'mergePullRequest') return mutationMergePullRequest(ctx, input);
      if (sel.name === 'addComment') return mutationAddComment(ctx, input);
      return undefined;
    }
    case 'User': {
      if (sel.name === 'login') return VIEWER_LOGIN;
      if (sel.name === 'id') return nodeId('User', String(VIEWER_ID));
      if (sel.name === 'name') return VIEWER_LOGIN;
      if (sel.name === 'email') return `${VIEWER_LOGIN}@example.invalid`;
      if (sel.name === 'url') return `https://github.com/${VIEWER_LOGIN}`;
      return undefined;
    }
    case 'Repository': {
      if (repo === undefined) return undefined;
      if (sel.name === 'owner') return { __typename: 'User', login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1000 };
      if (sel.name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return null;
        return { __typename: 'Ref', name: repo.defaultBranch, target: { oid: tip } };
      }
      if (sel.name === 'issue') {
        const number = args.number as number;
        const found = repo.issues.find((i) => i.number === number);
        return found === undefined ? null : issueNode(repo, found);
      }
      if (sel.name === 'issues') return issuesConnection(ctx, repo, args);
      if (sel.name === 'pullRequests') return pullsConnection(ctx, repo, args);
      if (sel.name === 'pullRequest') {
        const number = args.number as number;
        const found = repo.pulls.find((p) => p.number === number);
        return found === undefined ? null : pullNode(repo, found);
      }
      if (['id', 'databaseId', 'name', 'nameWithOwner', 'viewerPermission', 'hasIssuesEnabled', 'description', 'isPrivate'].includes(sel.name)) {
        return node[sel.name];
      }
      if (sel.name === 'createdAt') return repo.createdAt;
      if (sel.name === 'updatedAt') return repo.updatedAt;
      if (sel.name === 'url') return `https://github.com/${repo.owner}/${repo.name}`;
      return undefined;
    }
    case 'Issue': {
      if (issue === undefined || repo === undefined) return undefined;
      if (['id', 'number', 'title', 'body', 'state'].includes(sel.name)) return node[sel.name];
      if (sel.name === 'createdAt') return issue.createdAt;
      if (sel.name === 'updatedAt') return issue.updatedAt;
      if (sel.name === 'closedAt') return issue.closedAt;
      if (sel.name === 'author') return { __typename: 'User', login: issue.user, id: issue.user === VIEWER_LOGIN ? VIEWER_ID : 1000 };
      if (sel.name === 'labels') return { nodes: issue.labels.map((name) => ({ name })) };
      if (sel.name === 'comments') return { nodes: issue.comments.map((c) => ({ id: nodeId('IssueComment', `${repo.id}:${issue.number}:${c.id}`), body: c.body })) };
      if (sel.name === 'url') return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      if (sel.name === 'repository') return repoNode(repo);
      return undefined;
    }
    case 'PullRequest': {
      if (pull === undefined || repo === undefined) return undefined;
      if (['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName'].includes(sel.name)) return node[sel.name];
      if (sel.name === 'mergeable') {
        if (pull.state !== 'open') return 'UNKNOWN';
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
        if (baseTip === undefined) return 'UNKNOWN';
        return ctx.store.mergeConflicts(repo, baseTip, pull.headSha) ? 'CONFLICTING' : 'MERGEABLE';
      }
      if (sel.name === 'files') {
        const baseInfo = ctx.store.commitInfo(repo, pull.baseSha);
        const headInfo = ctx.store.commitInfo(repo, pull.headSha);
        if (baseInfo === undefined || headInfo === undefined) return { nodes: [] };
        const files = ctx.store.diffTrees(repo, baseInfo.tree, headInfo.tree);
        const first = typeof args.first === 'number' ? args.first : files.length;
        return { nodes: files.slice(0, first).map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions })) };
      }
      if (sel.name === 'createdAt') return pull.createdAt;
      if (sel.name === 'updatedAt') return pull.updatedAt;
      if (sel.name === 'mergedAt') return pull.mergedAt;
      if (sel.name === 'closedAt') return pull.state === 'closed' ? pull.updatedAt : null;
      if (sel.name === 'author') return { __typename: 'User', login: pull.user, id: pull.user === VIEWER_LOGIN ? VIEWER_ID : 1000 };
      if (sel.name === 'url') return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
      if (sel.name === 'repository') return repoNode(repo);
      return undefined;
    }
    case 'Ref': {
      if (sel.name === 'name') return node.name;
      if (sel.name === 'target') return node.target;
      return undefined;
    }
    case '__Type': {
      if (sel.name === 'name') return node.name;
      if (sel.name === 'fields') return node.fields ?? [];
      if (sel.name === 'enumValues') return node.enumValues ?? [];
      if (sel.name === 'kind') return node.enumValues !== undefined ? 'ENUM' : 'OBJECT';
      return undefined;
    }
    default:
      return undefined;
  }
}

/** The issues connection: filter, order, page by cursor. */
function issuesConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let issues = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (states !== undefined && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    issues = issues.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction === 'ASC' ? 1 : -1;
  issues.sort((a, b) => (a.createdAt < b.createdAt ? -direction : a.createdAt > b.createdAt ? direction : 0));
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const after = numberFromCursor((args.after as string | null) ?? null);
  if (after !== null) {
    const index = issues.findIndex((i) => i.number === after);
    if (index >= 0) issues = issues.slice(index + 1);
  }
  const page = issues.slice(0, first);
  return {
    nodes: page.map((i) => issueNode(repo, i)),
    pageInfo: {
      hasNextPage: issues.length > first,
      hasPreviousPage: after !== null,
      startCursor: page.length > 0 ? cursorFor(page[0]!.number) : null,
      endCursor: page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null,
    },
    totalCount: issues.length,
  };
}

/** The pull requests connection: open first, newest first, capped by `first`. */
function pullsConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let pulls = [...repo.pulls];
  const states = args.states as string[] | undefined;
  if (states !== undefined && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    pulls = pulls.filter((p) => wanted.has(p.state));
  } else {
    pulls = pulls.filter((p) => p.state === 'open');
  }
  pulls.sort((a, b) => b.number - a.number);
  const first = typeof args.first === 'number' ? args.first : pulls.length;
  const page = pulls.slice(0, first);
  return {
    nodes: page.map((p) => pullNode(repo, p)),
    pageInfo: {
      hasNextPage: pulls.length > first,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? cursorFor(page[0]!.number) : null,
      endCursor: page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null,
    },
    totalCount: pulls.length,
  };
}

// ---------------------------------------------------------------- mutations

function mutationCreateIssue(ctx: Ctx, input: Record<string, unknown>): Record<string, unknown> {
  const repo = findRepoByNodeId(ctx.store, String(input.repositoryId ?? ''));
  if (repo === null) {
    ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
    return { issue: null };
  }
  const title = String(input.title ?? '');
  if (title === '') {
    ctx.errors.push({ message: 'A title is required to create an issue.' });
    return { issue: null };
  }
  const now = ctx.store.nowIso();
  const issue: Issue = {
    id: repo.id * 100000 + repo.nextIssue,
    number: repo.nextIssue,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels: [],
    user: VIEWER_LOGIN,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: [],
  };
  repo.nextIssue += 1;
  repo.issues.push(issue);
  return { issue: issueNode(repo, issue) };
}

function mutationCloseIssue(ctx: Ctx, input: Record<string, unknown>): Record<string, unknown> {
  const found = findIssueByNodeId(ctx.store, String(input.issueId ?? ''));
  if (found === null) {
    ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
    return { issue: null };
  }
  found.issue.state = 'closed';
  found.issue.closedAt = ctx.store.nowIso();
  found.issue.updatedAt = ctx.store.nowIso();
  return { issue: issueNode(found.repo, found.issue) };
}

function mutationCreatePullRequest(ctx: Ctx, input: Record<string, unknown>): Record<string, unknown> {
  const repo = findRepoByNodeId(ctx.store, String(input.repositoryId ?? ''));
  if (repo === null) {
    ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
    return { pullRequest: null };
  }
  const head = String(input.headRefName ?? '');
  const base = String(input.baseRefName ?? '');
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined || baseSha === undefined) {
    ctx.errors.push({ message: 'Head or base branch does not exist.' });
    return { pullRequest: null };
  }
  const now = ctx.store.nowIso();
  const pull: Pull = {
    id: repo.id * 100000 + repo.nextPull,
    number: repo.nextPull,
    title: String(input.title ?? ''),
    body: typeof input.body === 'string' ? input.body : '',
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
  return { pullRequest: pullNode(repo, pull) };
}

function mutationMergePullRequest(ctx: Ctx, input: Record<string, unknown>): Record<string, unknown> {
  const found = findPullByNodeId(ctx.store, String(input.pullRequestId ?? ''));
  if (found === null) {
    ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
    return { pullRequest: null };
  }
  const { repo, pull } = found;
  if (pull.state !== 'open' || pull.merged) {
    ctx.errors.push({ message: 'Pull request is not open.' });
    return { pullRequest: pullNode(repo, pull) };
  }
  const baseRef = `refs/heads/${pull.baseRef}`;
  const baseTip = repo.refs.get(baseRef);
  if (baseTip === undefined) {
    ctx.errors.push({ message: 'Base branch does not exist.' });
    return { pullRequest: pullNode(repo, pull) };
  }
  const headInfo = ctx.store.commitInfo(repo, pull.headSha);
  if (headInfo === undefined || ctx.store.mergeConflicts(repo, baseTip, pull.headSha)) {
    ctx.errors.push({ message: 'Merge conflict.' });
    return { pullRequest: pullNode(repo, pull) };
  }
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
  const mergeSha = ctx.store.createCommit(repo, { tree: headInfo.tree, parents: [baseTip], message });
  repo.refs.set(baseRef, mergeSha);
  const now = ctx.store.nowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = mergeSha;
  pull.mergedAt = now;
  pull.updatedAt = now;
  return { pullRequest: pullNode(repo, pull) };
}

function mutationAddComment(ctx: Ctx, input: Record<string, unknown>): Record<string, unknown> {
  const found = findIssueByNodeId(ctx.store, String(input.subjectId ?? ''));
  if (found === null) {
    ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
    return { commentEdge: null };
  }
  const body = String(input.body ?? '');
  if (body === '') {
    ctx.errors.push({ message: 'A body is required to add a comment.' });
    return { commentEdge: null };
  }
  const now = ctx.store.nowIso();
  const comment = { id: found.repo.nextComment, body, user: VIEWER_LOGIN, createdAt: now, updatedAt: now };
  found.repo.nextComment += 1;
  found.issue.comments.push(comment);
  return {
    commentEdge: {
      node: { id: nodeId('IssueComment', `${found.repo.id}:${found.issue.number}:${comment.id}`), body: comment.body },
      cursor: cursorFor(comment.id),
    },
  };
}

// ---------------------------------------------------------------- execution

/** Execute one operation's selections against a root node, collecting errors. */
function executeSelections(
  ctx: Ctx,
  node: Record<string, unknown>,
  selections: Selection[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      const type = (node.__typename as string) ?? '';
      if (sel.typeCondition !== null && sel.typeCondition !== type) continue;
      Object.assign(out, executeSelections(ctx, node, sel.selections, variables));
      continue;
    }
    const value = resolveField(ctx, node, sel, variables);
    const key = sel.alias ?? sel.name;
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${node.__typename ?? 'Query'}".` });
      out[key] = null;
      continue;
    }
    out[key] = projectValue(ctx, value, sel.selections, variables);
  }
  return out;
}

/** Project a resolved value through its sub-selections (nodes, connections, scalars). */
function projectValue(ctx: Ctx, value: unknown, selections: Selection[], variables: Record<string, unknown>): unknown {
  if (value === null || selections.length === 0) return value;
  if (Array.isArray(value)) return value.map((v) => projectValue(ctx, v, selections, variables));
  if (typeof value === 'object') {
    const node = value as Record<string, unknown>;
    if (node.__typename !== undefined) return executeSelections(ctx, node, selections, variables);
    // A connection or a plain object: resolve each requested field against it.
    const out: Record<string, unknown> = {};
    for (const sel of selections) {
      if (sel.kind === 'fragment') continue;
      const raw = (node as Record<string, unknown>)[sel.name];
      if (raw === undefined) {
        ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "Connection".` });
        out[sel.alias ?? sel.name] = null;
        continue;
      }
      out[sel.alias ?? sel.name] = projectValue(ctx, raw, sel.selections, variables);
    }
    return out;
  }
  return value;
}

/** Run one operation document, returning its GraphQL response object. */
function runOperation(store: Store, query: string, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: Ctx = { store, errors: [] };
  try {
    const operation = new Parser(tokenize(query)).parseOperation();
    const root: Record<string, unknown> = { __typename: operation.kind === 'mutation' ? 'Mutation' : 'Query' };
    const data = executeSelections(ctx, root, operation.selections, variables);
    const response: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) response.errors = ctx.errors;
    return response;
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
}

export interface GraphQLResult {
  status: number;
  body: unknown;
}

/** POST /api/graphql: one operation, or a batched array of operations in order. */
export function handleGraphQL(store: Store, parsed: unknown, malformed: boolean): GraphQLResult {
  if (malformed) return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  if (Array.isArray(parsed)) {
    return {
      status: 200,
      body: parsed.map((entry) => {
        const query = typeof entry === 'object' && entry !== null ? String((entry as Record<string, unknown>).query ?? '') : '';
        const variables = typeof entry === 'object' && entry !== null ? ((entry as Record<string, unknown>).variables as Record<string, unknown>) ?? {} : {};
        return runOperation(store, query, variables);
      }),
    };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { status: 400, body: { errors: [{ message: 'A GraphQL query is required' }] } };
  }
  const record = parsed as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = (record.variables as Record<string, unknown>) ?? {};
  return { status: 200, body: runOperation(store, query, variables) };
}
