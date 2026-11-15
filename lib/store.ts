// Ember Forge's store: every repository's git objects and GitHub state, in memory.
//
// One fact the store cannot learn from any request: which login the bearer token names.
// The sealed env builds its scenario from one fixed seed, so the viewer is the same login in
// every trial — the first generated user, `adaiversen` (verified against the local env run,
// whose benchmark repos are created for adaiversen/...). A repository belongs to that login;
// any other owner in a path is a 404 for this token, never a 403.

import {
  hashObject,
  parseCommit,
  parseTree,
  serializeCommit,
  serializeTree,
  ZERO_OID,
  type GitObject,
  type ObjectType,
  type TreeEntry,
} from './gitobj.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;
export const ZERO = ZERO_OID;

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string | null;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  labels: Map<string, Label>;
  pulls: Pull[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
}

/** One changed path in a tree diff, with GitHub's file shape. */
export interface DiffFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  oldSha: string | null;
  newSha: string | null;
}

function ident(login: string, email: string, unix: number): string {
  return `${login} <${email}> ${unix} +0000`;
}

/** Split text into lines (a trailing newline does not make an empty last line). */
function linesOf(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Added/deleted line counts between two texts, by multiset difference of their lines. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = linesOf(oldText);
  const newLines = linesOf(newText);
  const counts = new Map<string, number>();
  for (const line of oldLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of counts.values()) deletions += left;
  return { additions, deletions };
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  /** A monotonic clock: every stamped event takes the next second, so creation order is total. */
  private clock: number;

  constructor() {
    const trialNow = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = trialNow === '' ? Number.NaN : Date.parse(trialNow) / 1000;
    this.clock = Number.isFinite(parsed) ? Math.trunc(parsed) : 1735689600;
  }

  /** The next timestamp (seconds), as an ISO string. */
  nowIso(): string {
    const unix = this.clock;
    this.clock += 1;
    return new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** The next timestamp (seconds), as a number. */
  nowUnix(): number {
    const unix = this.clock;
    this.clock += 1;
    return unix;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, opts: { description?: string; private?: boolean; defaultBranch?: string }): Repo {
    const now = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      createdAt: now,
      updatedAt: now,
      pushedAt: null,
      refs: new Map(),
      objects: new Map(),
      issues: [],
      labels: new Map(),
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  // ---------------------------------------------------------------- objects

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const sha = hashObject(type, data);
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
    return sha;
  }

  getObject(repo: Repo, sha: string): GitObject | undefined {
    return repo.objects.get(sha);
  }

  putBlob(repo: Repo, data: Buffer): string {
    return this.putObject(repo, 'blob', data);
  }

  // ---------------------------------------------------------------- trees

  /** Flatten a tree into path -> {mode, sha}, recursing into subtrees. */
  treePaths(repo: Repo, treeSha: string): Map<string, { mode: string; sha: string }> {
    const out = new Map<string, { mode: string; sha: string }>();
    const walk = (sha: string, prefix: string): void => {
      const obj = repo.objects.get(sha);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.sha, path);
        else out.set(path, { mode: entry.mode, sha: entry.sha });
      }
    };
    walk(treeSha, '');
    return out;
  }

  /**
   * A new root tree from a base tree plus file changes (path -> {mode, data} to write,
   * null to delete). Intermediate trees are created as needed; empty directories vanish.
   */
  buildTree(repo: Repo, baseTreeSha: string | null, changes: Map<string, { mode: string; data: Buffer } | null>): string {
    // A nested map: directory -> (name -> blob sha/mode, or a deeper directory).
    type Node = Map<string, { mode: string; sha: string } | Node>;
    const root: Node = new Map();
    const load = (treeSha: string | null, node: Node): void => {
      if (treeSha === null) return;
      const obj = repo.objects.get(treeSha);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '40000') {
          const child: Node = new Map();
          load(entry.sha, child);
          node.set(entry.name, child);
        } else {
          node.set(entry.name, { mode: entry.mode, sha: entry.sha });
        }
      }
    };
    load(baseTreeSha, root);
    const isNode = (v: { mode: string; sha: string } | Node): v is Node => v instanceof Map;
    const setPath = (node: Node, parts: string[], value: { mode: string; data: Buffer } | null): void => {
      const [head, ...rest] = parts as [string, ...string[]];
      if (rest.length === 0) {
        if (value === null) node.delete(head);
        else node.set(head, { mode: value.mode, sha: this.putBlob(repo, value.data) });
        return;
      }
      let child = node.get(head);
      if (child === undefined || !isNode(child)) {
        child = new Map();
        node.set(head, child);
      }
      setPath(child, rest, value);
      if (child.size === 0) node.delete(head);
    };
    for (const [path, value] of changes) {
      const parts = path.split('/').filter((p) => p !== '');
      if (parts.length === 0) continue;
      setPath(root, parts, value);
    }
    const write = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of node) {
        if (isNode(value)) entries.push({ mode: '40000', name, sha: write(value) });
        else entries.push({ mode: value.mode, name, sha: value.sha });
      }
      return this.putObject(repo, 'tree', serializeTree(entries));
    };
    return write(root);
  }

  // ---------------------------------------------------------------- commits

  createCommit(
    repo: Repo,
    opts: { tree: string; parents: string[]; message: string; author?: string; committer?: string },
  ): string {
    const unix = this.nowUnix();
    const author = opts.author ?? ident(VIEWER_LOGIN, VIEWER_EMAIL, unix);
    const committer = opts.committer ?? ident(VIEWER_LOGIN, VIEWER_EMAIL, unix);
    const data = serializeCommit({ tree: opts.tree, parents: opts.parents, author, committer, message: opts.message, extra: [] });
    return this.putObject(repo, 'commit', data);
  }

  /** A commit's parsed content, or undefined when the object is not a commit. */
  commitInfo(repo: Repo, sha: string): ReturnType<typeof parseCommit> | undefined {
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') return undefined;
    return parseCommit(obj.data);
  }

  /** All commits reachable from `tip`, newest first (by the store's monotonic clock). */
  commitHistory(repo: Repo, tip: string): string[] {
    const seen = new Set<string>();
    const queue = [tip];
    const commits: Array<{ sha: string; time: number }> = [];
    while (queue.length > 0) {
      const sha = queue.pop() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const info = this.commitInfo(repo, sha);
      if (info === undefined) continue;
      const time = Number(info.committer.split(' ').slice(-2, -1)[0] ?? 0);
      commits.push({ sha, time });
      for (const parent of info.parents) queue.push(parent);
    }
    commits.sort((a, b) => b.time - a.time);
    return commits.map((c) => c.sha);
  }

  /** Is `ancestor` reachable from `descendant` (following parents)? */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length > 0) {
      const sha = queue.pop() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const info = this.commitInfo(repo, sha);
      if (info === undefined) continue;
      for (const parent of info.parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** The nearest common ancestor of two tips (first found walking from `b`), or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const queueA = [a];
    while (queueA.length > 0) {
      const sha = queueA.pop() as string;
      if (ancestorsA.has(sha)) continue;
      ancestorsA.add(sha);
      const info = this.commitInfo(repo, sha);
      if (info !== undefined) for (const parent of info.parents) queueA.push(parent);
    }
    const seen = new Set<string>();
    const queueB = [b];
    while (queueB.length > 0) {
      const sha = queueB.shift() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      if (ancestorsA.has(sha)) return sha;
      const info = this.commitInfo(repo, sha);
      if (info !== undefined) for (const parent of info.parents) queueB.push(parent);
    }
    return null;
  }

  // ---------------------------------------------------------------- reachability

  /**
   * Every object id reachable from `tips` (commits, their trees and blobs, tags peeled),
   * optionally only `depth` generations of commits, and optionally minus the objects in
   * `exclude` (a fetch's haves, as a literal set of ids the client already holds).
   */
  reachable(repo: Repo, tips: readonly string[], opts: { depth?: number; exclude?: ReadonlySet<string> } = {}): Set<string> {
    const out = new Set<string>();
    // `exclude` is a literal set of object ids the caller already holds (a fetch's
    // haves, already expanded by the caller). It must NOT be re-expanded from its
    // members as tips: a shallow have's closure is exactly the set the caller computed,
    // and re-expanding it would pull the shallow commit's ancestors back in.
    const excluded = opts.exclude ?? new Set<string>();
    const depth = opts.depth;
    // `seen` tracks traversal so an excluded commit/tree is still walked through
    // (its parents/entries may be wanted) without revisiting it forever.
    const seen = new Set<string>();
    const visitTree = (treeSha: string): void => {
      if (seen.has(treeSha)) return;
      seen.add(treeSha);
      if (!excluded.has(treeSha)) out.add(treeSha);
      const obj = repo.objects.get(treeSha);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '40000') visitTree(entry.sha);
        else if (!excluded.has(entry.sha)) out.add(entry.sha);
      }
    };
    const visitCommit = (sha: string, generation: number): void => {
      if (seen.has(sha)) return;
      seen.add(sha);
      const info = this.commitInfo(repo, sha);
      if (info === undefined) return;
      if (!excluded.has(sha)) out.add(sha);
      visitTree(info.tree);
      // Always walk the parents: an excluded commit's parents may still be wanted
      // (a shallow have's parent is exactly such a case).
      if (depth === undefined || generation < depth) {
        for (const parent of info.parents) visitCommit(parent, generation + 1);
      }
    };
    for (const tip of tips) {
      const obj = repo.objects.get(tip);
      if (obj === undefined) continue;
      if (obj.type === 'commit') visitCommit(tip, 1);
      else if (obj.type === 'tree') visitTree(tip);
      else if (obj.type === 'tag') {
        out.add(tip);
        const tag = obj.data.toString('utf8');
        const match = /^object ([0-9a-f]{40})$/m.exec(tag);
        if (match) {
          const target = repo.objects.get(match[1]);
          if (target !== undefined) {
            if (target.type === 'commit') visitCommit(match[1], 1);
            else if (target.type === 'tree') visitTree(match[1]);
            else out.add(match[1]);
          }
        }
      } else out.add(tip);
    }
    return out;
  }

  /** The shallow boundary commits for a depth-limited fetch: the commits at exactly `depth`. */
  shallowBoundary(repo: Repo, tips: readonly string[], depth: number): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const walk = (sha: string, generation: number): void => {
      if (seen.has(sha)) return;
      seen.add(sha);
      const info = this.commitInfo(repo, sha);
      if (info === undefined) return;
      if (generation === depth) {
        out.push(sha);
        return;
      }
      for (const parent of info.parents) walk(parent, generation + 1);
    };
    for (const tip of tips) walk(tip, 1);
    return out;
  }

  // ---------------------------------------------------------------- diffs

  /** The file changes between two trees, with GitHub's file shape. */
  diffTrees(repo: Repo, baseTreeSha: string | null, headTreeSha: string | null): DiffFile[] {
    const base = baseTreeSha === null ? new Map() : this.treePaths(repo, baseTreeSha);
    const head = headTreeSha === null ? new Map() : this.treePaths(repo, headTreeSha);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: DiffFile[] = [];
    for (const path of [...paths].sort()) {
      const oldEntry = base.get(path);
      const newEntry = head.get(path);
      if (oldEntry !== undefined && newEntry !== undefined && oldEntry.sha === newEntry.sha) continue;
      if (oldEntry === undefined && newEntry !== undefined) {
        const blob = repo.objects.get(newEntry.sha);
        const text = blob?.type === 'blob' ? blob.data.toString('utf8') : '';
        const { additions } = lineDiff('', text);
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions, oldSha: null, newSha: newEntry.sha });
      } else if (oldEntry !== undefined && newEntry === undefined) {
        const blob = repo.objects.get(oldEntry.sha);
        const text = blob?.type === 'blob' ? blob.data.toString('utf8') : '';
        const { deletions } = lineDiff(text, '');
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions, oldSha: oldEntry.sha, newSha: null });
      } else if (oldEntry !== undefined && newEntry !== undefined) {
        const oldBlob = repo.objects.get(oldEntry.sha);
        const newBlob = repo.objects.get(newEntry.sha);
        const oldText = oldBlob?.type === 'blob' ? oldBlob.data.toString('utf8') : '';
        const newText = newBlob?.type === 'blob' ? newBlob.data.toString('utf8') : '';
        const { additions, deletions } = lineDiff(oldText, newText);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions, oldSha: oldEntry.sha, newSha: newEntry.sha });
      }
    }
    return out;
  }

  /** Would a squash merge of `headTip` onto `baseTip` conflict? (Same file changed both ways.) */
  mergeConflicts(repo: Repo, baseTip: string, headTip: string): boolean {
    const base = this.mergeBase(repo, baseTip, headTip);
    if (base === null) return false;
    const baseInfo = this.commitInfo(repo, base);
    const baseTree = baseInfo?.tree ?? null;
    const baseTipInfo = this.commitInfo(repo, baseTip);
    const headTipInfo = this.commitInfo(repo, headTip);
    if (baseTipInfo === undefined || headTipInfo === undefined) return false;
    const baseChanges = this.diffTrees(repo, baseTree, baseTipInfo.tree);
    const headChanges = this.diffTrees(repo, baseTree, headTipInfo.tree);
    const headByPath = new Map(headChanges.map((f) => [f.filename, f]));
    for (const change of baseChanges) {
      const other = headByPath.get(change.filename);
      if (other !== undefined && other.newSha !== change.newSha) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- refs

  resolveRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, sha: string): void {
    repo.refs.set(ref, sha);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  headTarget(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  /** The default branch's tip, or undefined when the repository is unborn. */
  headSha(repo: Repo): string | undefined {
    return repo.refs.get(this.headTarget(repo));
  }
}
