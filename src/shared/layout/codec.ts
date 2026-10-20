import type { Layout, RepoId, Section } from '../types';
import { COMPAT_SCHEMA, CURRENT_SCHEMA, MigrationError, migratePayload } from './migrations';
import { UNCATEGORIZED_ID, isValidRepoId, isValidSectionId, normalizeLayout } from './model';

/**
 * chrome.storage.sync layout encoding.
 *
 *   grn:h  -> { v, c, n, r, a, t, d }   head: schema, compat schema, chunk count, revision, ancestor
 *                                      revisions (newest first), time, first chunk
 *   grn:1 … grn:<n-1> -> "<r>|<slice>"
 *
 * The payload is JSON `{"s":[[id,name,collapsed,"b36,b36,…",…extra],…],…extra}`. Small layouts (the common
 * case, roughly up to 1,100 assigned repositories) fit entirely in the head item, which makes every write atomic
 * across devices. Larger layouts spill into chunk items, each stamped with the revision so a reader can tell
 * when Chrome Sync has delivered only part of a write.
 */
export const SYNC_PREFIX = 'grn:';
export const HEAD_KEY = 'grn:h';
export const chunkKey = (index: number): string => `${SYNC_PREFIX}${index}`;

/** chrome.storage.sync.QUOTA_BYTES_PER_ITEM / QUOTA_BYTES / MAX_ITEMS. */
export const SYNC_ITEM_QUOTA = 8192;
export const SYNC_TOTAL_QUOTA = 102400;
export const SYNC_MAX_ITEMS = 512;
const ITEM_BUDGET = SYNC_ITEM_QUOTA - 192;
/** Leave room for anything else in sync storage and for a growing layout to be reported before it fails. */
export const TOTAL_BUDGET = SYNC_TOTAL_QUOTA - 6144;
const MAX_CHUNKS = 64;

export interface SyncHead {
  v: number;
  c: number;
  n: number;
  r: string;
  /** Revisions this document descends from, newest first. Lets a device tell "includes my write" from "concurrent". */
  a: string[];
  t: number;
  d: string;
}

export const MAX_ANCESTORS = 16;
const REV_RE = /^[0-9a-z]{1,32}$/;

export class SyncQuotaError extends Error {
  constructor(readonly bytes: number) {
    super(`The layout needs ${bytes} bytes of Chrome Sync storage, above the ${TOTAL_BUDGET}-byte budget.`);
  }
}

const encoder = new TextEncoder();
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

const INT32_MAX = 2 ** 31 - 1;
const INT32_MIN = -(2 ** 31);

/**
 * Bytes Chrome charges for a value: its JSON as written by Chromium's base::WriteJson, which escapes '<',
 * U+2028 and U+2029 as six-byte \uXXXX sequences (JS JSON.stringify keeps them raw) and writes integers
 * outside the int32 range as doubles with a trailing ".0".
 */
export function chromeJsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) return 0;
  let bytes = utf8Bytes(json);
  for (const ch of json) if (ch === '<' || ch === '\u2028' || ch === '\u2029') bytes += ch === '<' ? 5 : 3;
  const visit = (v: unknown): void => {
    if (typeof v === 'number') {
      if (Number.isInteger(v) && (v > INT32_MAX || v < INT32_MIN)) bytes += 2;
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(value);
  return bytes;
}

/** Bytes Chrome charges for one item: key length plus the JSON of the value (Chromium's encoding). */
export function itemBytes(key: string, value: unknown): number {
  return utf8Bytes(key) + chromeJsonBytes(value);
}

/** Chromium-encoded size of one character inside a JSON string. */
function escapedCost(ch: string): number {
  if (ch === '<' || ch === '\u2028' || ch === '\u2029') return 6;
  return utf8Bytes(JSON.stringify(ch)) - 2;
}

export function newRevision(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

const B36_RE = /^[0-9a-z]{1,11}$/;
export function encodeRepoId(id: RepoId): string {
  return id.toString(36);
}
export function decodeRepoId(text: string): RepoId | null {
  if (!B36_RE.test(text)) return null;
  const id = parseInt(text, 36);
  return isValidRepoId(id) ? id : null;
}

export function layoutToPayload(layout: Layout): Record<string, unknown> {
  const s = layout.sections.map((section) => {
    const tuple: unknown[] = [
      section.id,
      section.id === UNCATEGORIZED_ID ? '' : section.name,
      section.collapsed ? 1 : 0,
      section.repoIds.map(encodeRepoId).join(','),
    ];
    if (section.extra && section.extra.length) tuple.push(...section.extra);
    return tuple;
  });
  return { ...layout.extra, s };
}

/** Decodes a current-schema payload. Malformed sections are skipped; invariants are restored by normalization. */
export function payloadToLayout(payload: unknown): Layout {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Layout payload is not an object.');
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.s)) throw new Error('Layout payload has no section list.');
  const sections: Section[] = [];
  for (const entry of record.s) {
    if (!Array.isArray(entry) || entry.length < 4) continue;
    const [id, name, collapsed, ids, ...rest] = entry as unknown[];
    if (!isValidSectionId(id) || typeof name !== 'string' || typeof ids !== 'string') continue;
    const repoIds: RepoId[] = [];
    for (const part of ids.split(',')) {
      if (!part) continue;
      const repoId = decodeRepoId(part);
      if (repoId !== null) repoIds.push(repoId);
    }
    const section: Section = { id, name, collapsed: collapsed === 1 || collapsed === true, repoIds };
    if (rest.length) section.extra = rest;
    sections.push(section);
  }
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) if (key !== 's') extra[key] = value;
  return normalizeLayout({ sections, extra });
}

/** Splits text into pieces whose JSON-escaped UTF-8 size fits each budget. Never splits a code point. */
function splitByEscapedBytes(text: string, firstBudget: number, budget: number): string[] {
  const pieces: string[] = [];
  let current = '';
  let used = 0;
  let limit = firstBudget;
  for (const ch of text) {
    const cost = escapedCost(ch);
    if (used + cost > limit && current) {
      pieces.push(current);
      current = '';
      used = 0;
      limit = budget;
    }
    current += ch;
    used += cost;
  }
  pieces.push(current);
  return pieces;
}

export interface EncodedLayout {
  items: Record<string, unknown>;
  chunkCount: number;
  bytes: number;
  head: SyncHead;
}

export interface WriteSchema {
  v: number;
  c: number;
}

/**
 * When this build edits a document written by a newer, compatible schema (its `c` is not above ours), the
 * newer `v`/`c` are written back unchanged: the newer writer declared that our edits (with its unknown fields
 * passed through) are still a valid document of its version.
 */
export function writeSchemaFor(head: Pick<SyncHead, 'v' | 'c'> | null): WriteSchema {
  if (!head || head.c > CURRENT_SCHEMA) return { v: CURRENT_SCHEMA, c: COMPAT_SCHEMA };
  return { v: Math.max(CURRENT_SCHEMA, head.v), c: Math.max(COMPAT_SCHEMA, head.c) };
}

export interface EncodeOptions {
  rev: string;
  now: number;
  schema?: WriteSchema;
  ancestors?: string[];
}

export function encodeLayout(layout: Layout, options: EncodeOptions): EncodedLayout {
  const { rev, now } = options;
  const schema = options.schema ?? { v: CURRENT_SCHEMA, c: COMPAT_SCHEMA };
  const ancestors = (options.ancestors ?? []).filter((r) => REV_RE.test(r) && r !== rev).slice(0, MAX_ANCESTORS);
  const json = JSON.stringify(layoutToPayload(layout));
  // Worst-case head overhead (3-digit chunk count) so the real head can only be smaller.
  const headOverhead = itemBytes(HEAD_KEY, { v: schema.v, c: schema.c, n: 999, r: rev, a: ancestors, t: now, d: '' });
  const chunkOverhead = itemBytes(chunkKey(MAX_CHUNKS), `${rev}|`);
  const pieces = splitByEscapedBytes(json, ITEM_BUDGET - headOverhead, ITEM_BUDGET - chunkOverhead);
  if (pieces.length > MAX_CHUNKS) throw new SyncQuotaError(utf8Bytes(json));
  const head: SyncHead = { v: schema.v, c: schema.c, n: pieces.length, r: rev, a: ancestors, t: now, d: pieces[0] ?? '' };
  const items: Record<string, unknown> = { [HEAD_KEY]: head };
  for (let i = 1; i < pieces.length; i++) items[chunkKey(i)] = `${rev}|${pieces[i]}`;
  let bytes = 0;
  for (const [key, value] of Object.entries(items)) bytes += itemBytes(key, value);
  if (bytes > TOTAL_BUDGET) throw new SyncQuotaError(bytes);
  return { items, chunkCount: pieces.length, bytes, head };
}

/** Chunk keys present in `existingKeys` that a document with `chunkCount` chunks no longer uses. */
export function staleChunkKeys(existingKeys: Iterable<string>, chunkCount: number): string[] {
  const stale: string[] = [];
  for (const key of existingKeys) {
    if (!key.startsWith(SYNC_PREFIX) || key === HEAD_KEY) continue;
    const index = Number(key.slice(SYNC_PREFIX.length));
    if (!Number.isInteger(index) || index < 1 || index >= chunkCount) stale.push(key);
  }
  return stale;
}

export type DecodeResult =
  | { status: 'empty' }
  | { status: 'ok'; layout: Layout; head: SyncHead; migratedFrom: number | null }
  | { status: 'readonly'; layout: Layout | null; head: SyncHead; reason: string }
  | { status: 'inconsistent'; head: SyncHead | null; reason: string }
  | { status: 'corrupt'; reason: string };

function parseHead(value: unknown): SyncHead | null {
  if (!value || typeof value !== 'object') return null;
  const h = value as Record<string, unknown>;
  const int = (x: unknown, min: number, max: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;
  if (!int(h.v, 1, 10_000) || !int(h.c, 1, 10_000) || h.c > h.v) return null;
  if (!int(h.n, 1, SYNC_MAX_ITEMS) || typeof h.r !== 'string' || !REV_RE.test(h.r)) return null;
  if (typeof h.t !== 'number' || !Number.isFinite(h.t) || typeof h.d !== 'string') return null;
  const a = Array.isArray(h.a) ? h.a.filter((r): r is string => typeof r === 'string' && REV_RE.test(r)).slice(0, MAX_ANCESTORS) : [];
  return { v: h.v, c: h.c, n: h.n, r: h.r, a, t: h.t, d: h.d };
}

/**
 * Reads everything under the `grn:` prefix. Never throws: callers decide what to do with each status, and the
 * important rule is that nothing but `ok` (or `empty`) may ever be overwritten automatically.
 */
export function decodeSyncItems(items: Record<string, unknown>, currentSchema: number = CURRENT_SCHEMA): DecodeResult {
  const rawHead = items[HEAD_KEY];
  if (rawHead === undefined) {
    const strays = Object.keys(items).some((k) => k.startsWith(SYNC_PREFIX));
    return strays ? { status: 'inconsistent', head: null, reason: 'Layout chunks arrived without their head.' } : { status: 'empty' };
  }
  const head = parseHead(rawHead);
  if (!head) return { status: 'corrupt', reason: 'The synced layout head is malformed.' };

  let json = head.d;
  for (let i = 1; i < head.n; i++) {
    const piece = items[chunkKey(i)];
    if (typeof piece !== 'string' || !piece.startsWith(`${head.r}|`)) {
      return { status: 'inconsistent', head, reason: `Chunk ${i} of ${head.n - 1} has not arrived for revision ${head.r}.` };
    }
    json += piece.slice(head.r.length + 1);
  }

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    payload = parsed as Record<string, unknown>;
  } catch {
    return { status: 'corrupt', reason: 'The synced layout could not be parsed.' };
  }

  if (head.c > currentSchema) {
    let layout: Layout | null;
    try {
      layout = payloadToLayout(payload);
    } catch {
      layout = null;
    }
    return {
      status: 'readonly',
      layout,
      head,
      reason: `Your sections were saved by a newer version of GitHub Repo Navigator (schema ${head.v}). Update the extension on this device to edit them.`,
    };
  }

  let migratedFrom: number | null = null;
  if (head.v < currentSchema) {
    try {
      payload = migratePayload(payload, head.v, currentSchema);
      migratedFrom = head.v;
    } catch (error) {
      return { status: 'corrupt', reason: error instanceof MigrationError ? error.message : 'Migration failed.' };
    }
  }

  try {
    return { status: 'ok', layout: payloadToLayout(payload), head, migratedFrom };
  } catch (error) {
    return { status: 'corrupt', reason: error instanceof Error ? error.message : 'Invalid layout.' };
  }
}
