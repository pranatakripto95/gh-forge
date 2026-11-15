// Ember Forge's git object model: the four object kinds, their hashes, and the packfile
// format (read and write), all on node:crypto and node:zlib. No git binary anywhere.
//
// A packfile the forge WRITES holds plain objects only (no deltas): git does not require a
// pack to be deltified, and plain objects are faster to build and impossible to get wrong.
// A packfile the forge READS may hold OFS_DELTA and REF_DELTA entries (a real git client
// sends them), so the decoder resolves both against the pack itself or the store.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** Is `s` a 40-hex object id (or the zero id). */
export function isObjectId(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

/** The git id of an object: sha1("<type> <len>\0" + data). */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** The stored form of an object (header + data), what a packfile entry deflates. */
export function objectBytes(type: ObjectType, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'ascii'), data]);
}

/** Parse stored object bytes back into type + data. */
export function parseObjectBytes(raw: Buffer): GitObject {
  const nul = raw.indexOf(0);
  if (nul < 0) throw new Error('object has no header');
  const header = raw.subarray(0, nul).toString('ascii');
  const [type, len] = header.split(' ');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`unknown object type ${JSON.stringify(type)}`);
  }
  if (Number(len) !== raw.length - nul - 1) throw new Error('object length does not match its header');
  return { type, data: Buffer.from(raw.subarray(nul + 1)) };
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // '100644' | '100755' | '120000' | '40000'
  name: string;
  sha: string;
}

/** Git's tree order: entries sort by name, a directory sorting as if its name ended in '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialize a tree's entries (sorted) into the tree object's data. */
export function serializeTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object's data into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const nul = data.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree entry');
    entries.push({
      mode: data.subarray(i, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      sha: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    i = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------- commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  extra: string[]; // any other header lines, kept verbatim (gpgsig, encoding, ...)
}

/** Parse a commit object's data. The message is everything after the first blank line. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message, extra: [] };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
    else if (line) info.extra.push(line);
  }
  return info;
}

/** Build a commit object's data from its parts. */
export function serializeCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`, `committer ${info.committer}`);
  for (const extra of info.extra) lines.push(extra);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object's data. */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const info: TagInfo = { object: '', type: 'commit', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim() as ObjectType;
    else if (line.startsWith('tag ')) info.tag = line.slice(4);
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

// ---------------------------------------------------------------- packfiles

const TYPE_NUM: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Write a packfile entry header: the type and size as git's varint. */
function packEntryHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (size & 0x0f) | (typeNum << 4);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Build a version-2 packfile from plain objects (no deltas), in the caller's order. */
export function encodePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK'), Buffer.alloc(4), Buffer.alloc(4)];
  parts[1].writeUInt32BE(2, 0);
  parts[2].writeUInt32BE(objects.length, 0);
  for (const obj of objects) {
    // A pack entry holds the object's data alone (no "<type> <len>\0" header): the header's
    // type and size fields carry that, and the id is recomputed from them on read.
    parts.push(packEntryHeader(TYPE_NUM[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const checksum = createHash('sha1').update(body).digest();
  return Buffer.concat([body, checksum]);
}

/** Read a varint from `buf` at `pos`: 7 bits a byte, low group first, MSB means continue. */
function readVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = pos;
  for (;;) {
    if (i >= buf.length) throw new Error('packfile ends inside a varint');
    const byte = buf[i];
    i += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: i };
}

/** Apply a git delta to its base, returning the reconstructed object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const src = readVarint(delta, pos);
  pos = src.next;
  if (src.value !== base.length) throw new Error('delta source size does not match its base');
  const tgt = readVarint(delta, pos);
  pos = tgt.next;
  const out: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (pos >= delta.length) throw new Error('delta copy runs past its end');
          offset |= delta[pos] << (bit * 8);
          pos += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          if (pos >= delta.length) throw new Error('delta copy runs past its end');
          size |= delta[pos] << (bit * 8);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy runs past its base');
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      if (pos + op > delta.length) throw new Error('delta insert runs past its end');
      out.push(delta.subarray(pos, pos + op));
      outLen += op;
      pos += op;
    } else {
      throw new Error('delta has a zero opcode');
    }
  }
  if (outLen !== tgt.value) throw new Error('delta target size does not match its instructions');
  return Buffer.concat(out);
}

export interface DecodedPack {
  /** Every object the pack holds, by id, deltas resolved. */
  objects: Map<string, GitObject>;
  /** How many of the pack's entries were deltas. */
  deltaCount: number;
}

/**
 * Decode a packfile, resolving OFS_DELTA and REF_DELTA entries against the pack itself or
 * `resolveBase` (the store: a thin pack's base may live outside it). Returns every object by id.
 */
export function decodePack(
  buf: Buffer,
  resolveBase: (sha: string) => GitObject | undefined,
): DecodedPack {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let pos = 12;
  let deltaCount = 0;
  // First pass: read every entry's raw bytes (inflating deltas' data but not applying them).
  interface RawEntry {
    offset: number;
    typeNum: number;
    baseSha?: string;
    baseOffset?: number;
    delta?: Buffer;
    raw?: Buffer;
  }
  const entries: RawEntry[] = [];
  for (let n = 0; n < count; n += 1) {
    const offset = pos;
    if (pos >= buf.length) throw new Error('packfile ends before its objects do');
    let byte = buf[pos];
    pos += 1;
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (pos >= buf.length) throw new Error('packfile ends inside an object header');
      byte = buf[pos];
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const entry: RawEntry = { offset, typeNum };
    if (typeNum === 6) {
      // OFS_DELTA: the base is `offset` bytes back, encoded git's way.
      if (pos >= buf.length) throw new Error('packfile ends inside an ofs-delta offset');
      byte = buf[pos];
      pos += 1;
      let baseOffset = byte & 0x7f;
      while (byte & 0x80) {
        if (pos >= buf.length) throw new Error('packfile ends inside an ofs-delta offset');
        byte = buf[pos];
        pos += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      entry.baseOffset = offset - baseOffset;
      deltaCount += 1;
    } else if (typeNum === 7) {
      if (pos + 20 > buf.length) throw new Error('packfile ends inside a ref-delta base');
      entry.baseSha = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      deltaCount += 1;
    } else if (NUM_TYPE[typeNum] === undefined) {
      throw new Error(`unknown pack object type ${typeNum}`);
    }
    // The zlib stream: inflate it (its end is wherever inflate stops).
    const { inflated, consumed } = inflateFrom(buf, pos, size);
    pos += consumed;
    if (entry.typeNum === 6 || entry.typeNum === 7) entry.delta = inflated;
    else entry.raw = inflated;
    entries.push(entry);
  }
  // Second pass: resolve, in order (a delta's base always precedes it in a pack git writes).
  // A pack entry's data is the object's content alone; the type comes from the entry header
  // (plain) or the base (delta), and the id is recomputed from type + content.
  const resolve = (entry: RawEntry): GitObject => {
    if (entry.raw !== undefined) {
      return { type: NUM_TYPE[entry.typeNum] as ObjectType, data: entry.raw };
    }
    let base: GitObject | undefined;
    if (entry.baseOffset !== undefined) base = byOffset.get(entry.baseOffset);
    else if (entry.baseSha !== undefined) base = objects.get(entry.baseSha) ?? resolveBase(entry.baseSha);
    if (base === undefined) throw new Error('delta base is not in the pack or the store');
    const data = applyDelta(base.data, entry.delta as Buffer);
    return { type: base.type, data };
  };
  for (const entry of entries) {
    const obj = resolve(entry);
    const sha = hashObject(obj.type, obj.data);
    objects.set(sha, obj);
    byOffset.set(entry.offset, obj);
  }
  return { objects, deltaCount };
}

/**
 * Inflate one zlib stream starting at `pos`, returning the bytes and how many were consumed.
 * Node's inflateSync ignores trailing bytes and throws on a truncated stream, so success is
 * monotonic in the window size: grow the window (doubling from a size hint) until it inflates,
 * then binary-search the exact end. The window only ever covers this object's own bytes, never
 * the rest of the pack, so decoding stays linear in the pack's size.
 */
function inflateFrom(buf: Buffer, pos: number, hintSize: number): { inflated: Buffer; consumed: number } {
  const tryAt = (end: number): Buffer | null => {
    try {
      return inflateSync(buf.subarray(pos, Math.min(end, buf.length)));
    } catch {
      return null;
    }
  };
  let end = pos + Math.max(64, hintSize + 32);
  let inflated = tryAt(end);
  let lo = pos + 1;
  while (inflated === null) {
    lo = end;
    if (end >= buf.length) throw new Error('packfile has an undecodable zlib stream');
    end = Math.min(buf.length, end * 2);
    inflated = tryAt(end);
  }
  // Binary-search the smallest window that inflates: (lo, end] holds the stream's end.
  let hi = end;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (tryAt(mid) !== null) hi = mid;
    else lo = mid;
  }
  return { inflated: inflateSync(buf.subarray(pos, hi)), consumed: hi - pos };
}

/** Verify a packfile's trailing checksum. */
export function verifyPackChecksum(buf: Buffer): boolean {
  if (buf.length < 20) return false;
  const want = buf.subarray(buf.length - 20);
  const got = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  return want.equals(got);
}
