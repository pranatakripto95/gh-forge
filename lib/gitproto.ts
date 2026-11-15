// Ember Forge's git smart-HTTP surface: pkt-line framing, the protocol-v2 upload-pack
// (advertisement, ls-refs, fetch) and the protocol-v0 receive-pack (advertisement, push).
// The wire the suite's client speaks is in the kit's sdk/conformance/git-client.ts; this
// module mirrors it, section for section.

import {
  decodePack,
  encodePack,
  isObjectId,
  parseTag,
  ZERO_OID,
  type GitObject,
} from './gitobj.ts';
import { Store, type Repo } from './store.ts';

const AGENT = 'ember-forge/1.0';
const UPLOAD_CAPABILITIES = 'ls-refs=unborn fetch=shallow wait-for-done object-format=sha1 agent=ember-forge/1.0';
const RECEIVE_CAPABILITIES =
  'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=ember-forge/1.0';

/** One pkt-line: 4 hex digits of (payload length + 4), then the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktKind = 'data' | 'flush' | 'delim';

/** Decode a whole buffer of pkt-lines into packets, stopping at the first flush. */
export function decodePktLines(buf: Buffer): Array<{ kind: PktKind; payload: Buffer }> {
  const out: Array<{ kind: PktKind; payload: Buffer }> = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const len = Number.parseInt(buf.subarray(pos, pos + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('pkt-line has a bad length');
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return out;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > buf.length) throw new Error('pkt-line runs past its buffer');
    out.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return out;
}

/**
 * Split a request body into its pkt-line section and the raw tail that follows the first
 * flush (a receive-pack's packfile). Returns the lines and the tail's start offset.
 */
export function splitPktBody(buf: Buffer): { lines: string[]; tail: Buffer } {
  const lines: string[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const len = Number.parseInt(buf.subarray(pos, pos + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      // flush: the pkt-line section ends here; the tail is the raw bytes after it.
      pos += 4;
      break;
    }
    if (len === 1) {
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > buf.length) break;
    lines.push(buf.subarray(pos + 4, pos + len).toString('utf8'));
    pos += len;
  }
  return { lines, tail: buf.subarray(pos) };
}

// ---------------------------------------------------------------- advertisements

/** The v2 capability advertisement for git-upload-pack. */
export function uploadPackAdvertisement(_repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), pktFlush(), pktLine('version 2\n')];
  for (const capability of UPLOAD_CAPABILITIES.split(' ')) parts.push(pktLine(`${capability}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v0 ref advertisement for git-receive-pack, with its push capabilities. */
export function receivePackAdvertisement(repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), pktFlush()];
  const capabilities = `${RECEIVE_CAPABILITIES} symref=HEAD:${repo.defaultBranch === '' ? 'refs/heads/main' : `refs/heads/${repo.defaultBranch}`}`;
  const headSha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    const first = refs[0] as { oid: string; name: string };
    parts.push(pktLine(`${first.oid} ${first.name}\0${capabilities}\n`));
    for (const ref of refs.slice(1)) parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
    for (const ref of refs) {
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The repository's refs, HEAD first, then the rest sorted by name. */
function sortedRefs(repo: Repo): Array<{ oid: string; name: string }> {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ oid, name }));
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const head = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(head);
  const out: Array<{ oid: string; name: string }> = [];
  if (headOid !== undefined) out.push({ oid: headOid, name: 'HEAD' });
  for (const ref of refs) out.push(ref);
  return out;
}

/** The commit an annotated tag peels to, or null when the object is not a tag. */
function peeledOid(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return null;
  const tag = parseTag(obj.data);
  const target = repo.objects.get(tag.object);
  if (target === undefined) return null;
  if (target.type === 'commit') return tag.object;
  if (target.type === 'tag') return peeledOid(repo, tag.object);
  return null;
}

// ---------------------------------------------------------------- ls-refs (v2)

/** Answer a v2 ls-refs request body with the repository's refs. */
export function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const { lines } = splitPktBody(body);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (keep('HEAD')) {
    if (headOid === undefined) {
      if (unborn) parts.push(pktLine(`unborn HEAD symref-target:${headRef}\n`));
    } else if (symrefs) {
      parts.push(pktLine(`${headOid} HEAD symref-target:${headRef}\n`));
    } else {
      parts.push(pktLine(`${headOid} HEAD\n`));
    }
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [name, oid] of refs) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peeledOid(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch (v2)

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenRelative: boolean;
  filter: string | null;
}

/** Parse a v2 fetch request body into its wants, haves, shallow boundaries and depth. */
/** The generation of `target` walking parents from `tips` (a tip is generation 1). */
function generationOf(store: Store, repo: Repo, tips: readonly string[], target: string): number | undefined {
  const seen = new Set<string>();
  const queue: Array<[string, number]> = tips.map((t) => [t, 1]);
  while (queue.length > 0) {
    const [sha, gen] = queue.shift() as [string, number];
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (sha === target) return gen;
    const info = store.commitInfo(repo, sha);
    if (info === undefined) continue;
    for (const parent of info.parents) queue.push([parent, gen + 1]);
  }
  return undefined;
}

function parseFetchRequest(body: Buffer): FetchRequest {
  const { lines } = splitPktBody(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepenRelative: false, filter: null };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) req.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) req.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) req.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) req.depth = Number.parseInt(text.slice(7).trim(), 10);
    else if (text === 'deepen-relative') req.deepenRelative = true;
    else if (text.startsWith('filter ')) req.filter = text.slice(7).trim();
  }
  return req;
}

/**
 * Answer a v2 fetch: the acknowledgments, shallow-info, wanted-refs and packfile sections.
 * The pack holds the objects reachable from the wants (to `depth` when given) that the
 * client does not already have, as plain objects — no deltas, so the pack is always valid.
 */
export function handleFetch(store: Store, repo: Repo, body: Buffer): Buffer {
  const req = parseFetchRequest(body);
  const wants = [...new Set(req.wants)].filter((w) => isObjectId(w) && repo.objects.has(w));
  const haves = new Set(req.haves.filter((h) => isObjectId(h)));
  const haveObjects = store.reachable(repo, [...haves]);
  if (req.shallow.length > 0) {
    // A shallow client holds each boundary commit (and its tree/blobs) but NOTHING
    // beyond it: a `have` of a shallow commit must not exclude its parents. Remove
    // everything reachable from a boundary commit's parents from the have-set, so a
    // deepen actually delivers the next generation.
    for (const boundary of req.shallow) {
      const info = store.commitInfo(repo, boundary);
      if (info === undefined) continue;
      for (const id of store.reachable(repo, info.parents)) haveObjects.delete(id);
    }
  }
  // `deepen N` alone is an absolute depth; with `deepen-relative` (real git's
  // `fetch --deepen=N`) it extends the client's current depth by N. The current
  // depth is the shallow boundary's generation from a want (tip = generation 1).
  let depth = req.depth;
  if (depth !== null && req.deepenRelative && req.shallow.length > 0) {
    let current = 0;
    for (const boundary of req.shallow) {
      const gen = generationOf(store, repo, wants, boundary);
      if (gen !== undefined) current = Math.max(current, gen);
    }
    if (current > 0) depth = current + depth;
  }
  const wantObjects =
    depth === null
      ? store.reachable(repo, wants, { exclude: haveObjects })
      : store.reachable(repo, wants, { depth, exclude: haveObjects });
  // The shallow boundaries of this fetch: the commits at exactly `depth` from a want.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const boundary of store.shallowBoundary(repo, wants, depth)) {
      if (!shallow.includes(boundary)) shallow.push(boundary);
    }
    for (const boundary of req.shallow) {
      // A boundary the client held is no longer shallow once its parents are in the pack.
      const info = store.commitInfo(repo, boundary);
      if (info !== undefined && info.parents.every((p) => wantObjects.has(p) || haveObjects.has(p))) {
        if (!unshallow.includes(boundary)) unshallow.push(boundary);
      }
    }
  } else {
    // A full fetch resolves every boundary the client held.
    for (const boundary of req.shallow) if (!unshallow.includes(boundary)) unshallow.push(boundary);
  }
  // The pack: the wanted objects, commits first (so a reader sees parents before children is
  // not required — a pack's order is the writer's — but deterministic ordering keeps replays
  // identical). Sort by id for determinism.
  const packObjects: GitObject[] = [...wantObjects]
    .sort()
    .map((sha) => repo.objects.get(sha))
    .filter((o): o is GitObject => o !== undefined);
  const pack = encodePack(packObjects);

  const parts: Buffer[] = [];
  // acknowledgments — only when the client sent haves to negotiate. A request that
  // already carried `done` with no haves gets no acknowledgments section (this is
  // what real git's upload-pack does, and real git errors if it is present).
  if (haves.size > 0) {
    parts.push(pktLine('acknowledgments\n'));
    const acked = [...haves].filter((h) => repo.objects.has(h));
    if (acked.length === 0) parts.push(pktLine('NAK\n'));
    else for (const oid of acked) parts.push(pktLine(`ACK ${oid}\n`));
    parts.push(pktLine('ready\n'));
    parts.push(pktDelim());
  }
  // shallow-info
  parts.push(pktLine('shallow-info\n'));
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktDelim());
  // No wanted-refs section: real git's upload-pack does not send one for an oid
  // fetch, and the conformance client does not need it.
  // packfile, as sideband-64k frames (band 1), chunked to the packet limit.
  parts.push(pktLine('packfile\n'));
  const CHUNK = 65515;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const frame = Buffer.concat([Buffer.from([1]), pack.subarray(i, Math.min(pack.length, i + CHUNK))]);
    parts.push(pktLine(frame));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack (v0)

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Answer a v0 receive-pack: parse the command list and the packfile, store the objects, apply
 * the ref updates that fast-forward, and report unpack + one ok/ng line per ref (in sideband
 * when the client asked for it). A refused update still unpacks: the objects stay.
 */
export function handleReceivePack(store: Store, repo: Repo, body: Buffer): { status: number; body: Buffer; contentType: string } {
  const { lines, tail } = splitPktBody(body);
  let capabilities = '';
  const commands: PushCommand[] = [];
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === '') continue;
    const nul = text.indexOf('\0');
    const command = nul >= 0 ? text.slice(0, nul) : text;
    if (nul >= 0 && capabilities === '') capabilities = text.slice(nul + 1);
    const parts = command.split(' ');
    if (parts.length !== 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (isObjectId(oldOid) && isObjectId(newOid)) commands.push({ oldOid, newOid, ref });
  }
  const wantSideband = capabilities.split(' ').includes('side-band-64k');
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  // The packfile follows the command list (a delete-only push sends none).
  const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
  if (updatesRef && tail.length > 0) {
    try {
      const { objects } = decodePack(tail, (sha) => repo.objects.get(sha));
      for (const [sha, obj] of objects) {
        if (!repo.objects.has(sha)) repo.objects.set(sha, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete: the old value must match the ref (or the ref must exist).
        if (current === undefined) {
          reportLines.push(`ng ${command.ref} cannot delete a ref that does not exist`);
        } else if (current !== command.oldOid) {
          reportLines.push(`ng ${command.ref} old value does not match`);
        } else {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}`);
        }
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        // Create: the ref must not exist yet.
        if (current !== undefined) {
          reportLines.push(`ng ${command.ref} already exists`);
        } else if (!repo.objects.has(command.newOid)) {
          reportLines.push(`ng ${command.ref} new object is not in the pack`);
        } else {
          repo.refs.set(command.ref, command.newOid);
          reportLines.push(`ok ${command.ref}`);
        }
        continue;
      }
      // Update: the old value must match, and the new tip must descend from it.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} cannot update a ref that does not exist`);
      } else if (current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} old value does not match`);
      } else if (command.newOid === command.oldOid) {
        reportLines.push(`ok ${command.ref}`);
      } else if (!repo.objects.has(command.newOid)) {
        reportLines.push(`ng ${command.ref} new object is not in the pack`);
      } else if (!store.isAncestor(repo, command.oldOid, command.newOid)) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}`);
      }
    }
    repo.pushedAt = new Date().toISOString();
  }
  // The report-status stream: `unpack ok`, one line per ref, terminated by a flush.
  // That flush belongs to the stream itself, so it rides INSIDE the sideband frame
  // when sideband is in use (real git's upload-pack does exactly this); the outer
  // flush then terminates the response.
  const reportStream = Buffer.concat([
    pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`),
    ...reportLines.map((line) => pktLine(`${line}\n`)),
    pktFlush(),
  ]);
  if (wantSideband) {
    const frame = Buffer.concat([Buffer.from([1]), reportStream]);
    return { status: 200, body: Buffer.concat([pktLine(frame), pktFlush()]), contentType: 'application/x-git-receive-pack-result' };
  }
  return { status: 200, body: reportStream, contentType: 'application/x-git-receive-pack-result' };
}
