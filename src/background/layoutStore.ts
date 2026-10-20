import { HEAD_KEY, SYNC_PREFIX, SyncQuotaError, decodeSyncItems, encodeLayout, itemBytes, newRevision, staleChunkKeys, writeSchemaFor, type DecodeResult, type SyncHead } from '../shared/layout/codec';
import { applyOp, applyOps, emptyLayout, isValidLayoutOp, layoutsEqual, resolveOp, type LayoutOp } from '../shared/layout/model';
import type { Layout, LayoutSnapshot, RepoId, SyncHealth } from '../shared/types';

export interface StorageAreaLike {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface LayoutStoreDeps {
  sync: StorageAreaLike;
  local: StorageAreaLike;
  timers: Timers;
  inventory(): ReadonlySet<RepoId>;
  emit(snapshot: LayoutSnapshot): void;
  /**
   * Ask the platform to wake the worker after `ms` (an MV3 service worker is terminated after ~30 s idle, which
   * would drop a long setTimeout). When the worker wakes, it re-reads the mirror and flushes.
   */
  wake?: (ms: number) => void;
  newRevision?: () => string;
  random?: () => number;
}

export const MIRROR_KEY = 'layout.mirror';
/** Coalesce bursts (drags, repeated collapse toggles) into one write. */
export const DEBOUNCE_MS = 2000;
/** Never write more often than this (MAX_WRITE_OPERATIONS_PER_MINUTE is 120 per method). */
export const MIN_SPACING_MS = 3000;
/** Sync write operations (set and remove counted separately) per hour; Chrome's MAX_WRITE_OPERATIONS_PER_HOUR is 1800. */
export const HOURLY_WRITE_BUDGET = 1200;
export const RETRY_MS = 60_000;
/** After a fresh start with nothing in sync, wait this long for Chrome Sync to deliver another device's layout. */
export const SETTLE_MS = 15_000;
export const REPAIR_MS = 20_000;
/** How long a written operation waits for another device's document to acknowledge it before we stop replaying it. */
export const RECENT_TTL_MS = 10 * 60_000;
/** Longer timers than this may not survive the service worker's idle shutdown; they also arm a wake-up. */
const WAKE_THRESHOLD_MS = 25_000;
const MAX_REVS_PER_OP = 8;
const MAX_OWN_REVS = 500;
const REMOTE_DEBOUNCE_MS = 250;

/** An operation plus every revision it has been written in (replays keep their history). */
interface OpEntry {
  op: LayoutOp;
  revs: string[];
  /** When it was last written; replays stop after RECENT_TTL_MS. */
  at: number;
}

interface OwnRev {
  rev: string;
  at: number;
}

type HeadInfo = Omit<SyncHead, 'd'>;

interface Mirror {
  pending: OpEntry[];
  recent: OpEntry[];
  ownRevs: OwnRev[];
  /** The last document this device decoded or wrote (null: never saw a good one). */
  base: Layout | null;
  baseHead: HeadInfo | null;
  /** A reset the user asked for that has not reached Chrome Sync yet. */
  resetPending: boolean;
}

type Mode = { kind: 'ok' } | { kind: 'readonly'; reason: string; schema: number } | { kind: 'corrupt'; reason: string } | { kind: 'error'; message: string };
type WriteMode = 'normal' | 'repair' | 'reset';

export type ApplyResult = { ok: true; snapshot: LayoutSnapshot } | { ok: false; error: string; snapshot: LayoutSnapshot };

/**
 * The only writer of the synced layout. All tabs and the options page send operations here.
 *
 * Invariants:
 * - An accepted operation is in the local mirror before the caller hears back, so a worker restart cannot
 *   lose it; it reaches sync on the next flush.
 * - Sync writes are coalesced (debounce + minimum spacing + hourly budget) and each is one set() of a
 *   self-consistent document (plus a remove() when the chunk count shrinks).
 * - Writes, remote reloads, resets and repairs run one at a time, and a write first checks that sync still
 *   holds the document it is based on (compare-and-set); otherwise it adopts the newer document instead.
 * - Remote changes replace the base and pending operations are replayed on top (rebase). Operations we already
 *   wrote are replayed too when the remote document does not descend from them, so edits made on two devices
 *   at once are both kept. A document that descends from any revision we wrote acknowledges every operation
 *   we wrote up to that revision (our documents are cumulative).
 * - Documents that are read-only (newer schema), corrupt, or partially delivered are never overwritten
 *   automatically; partial deliveries are repaired only after they stay inconsistent, and only from a layout
 *   this device has actually decoded.
 */
export class LayoutStore {
  private base: Layout = emptyLayout();
  private baseHead: HeadInfo | null = null;
  /** The base came from a decoded document (now or before a restart), so it may be written back. */
  private trustedBase = false;
  private pending: OpEntry[] = [];
  private recent: OpEntry[] = [];
  private ownRevs: OwnRev[] = [];
  private resetPending = false;
  private current: Layout = emptyLayout();
  private mode: Mode = { kind: 'ok' };
  private lastWrittenRev: string | null = null;
  private lastWriteAt: number | null = null;
  private lastFlushStart = -Infinity;
  private writeTimes: number[] = [];
  private flushTimer: unknown = null;
  private remoteTimer: unknown = null;
  private repairTimer: unknown = null;
  private settleUntil = 0;
  private bytes = 0;
  private chunks = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly epoch: string;
  private seq = 0;
  private readonly rev: () => string;

  constructor(private readonly deps: LayoutStoreDeps) {
    this.rev = deps.newRevision ?? newRevision;
    this.epoch = this.rev();
  }

  /** Runs `task` after every earlier write/reload/reset/repair has finished. */
  private serial(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async init(): Promise<void> {
    const [mirrorItems, syncItems] = await Promise.all([this.deps.local.get(MIRROR_KEY), this.deps.sync.get(null)]);
    const mirror = parseMirror(mirrorItems[MIRROR_KEY]);
    const decoded = decodeSyncItems(syncItems);
    this.pending = mirror?.pending ?? [];
    this.recent = mirror?.recent ?? [];
    this.ownRevs = mirror?.ownRevs ?? [];
    this.resetPending = mirror?.resetPending ?? false;
    if (this.resetPending) {
      // The user's reset has not reached sync yet: it wins over whatever sync still holds.
      this.base = emptyLayout();
      this.trustedBase = true;
      this.recompute();
      this.scheduleFlush();
      return;
    }
    switch (decoded.status) {
      case 'ok':
        this.adoptDocument(decoded.layout, decoded.head, syncItems);
        break;
      case 'empty':
        this.base = emptyLayout();
        this.trustedBase = true;
        // Fresh profile (or sync not yet downloaded): hold our first write so another device's layout can
        // arrive and our early edits are rebased onto it instead of replacing it.
        if (!mirror?.baseHead) this.settleUntil = this.deps.timers.now() + SETTLE_MS;
        break;
      case 'readonly':
        this.base = decoded.layout ?? mirror?.base ?? emptyLayout();
        this.baseHead = headInfo(decoded.head);
        this.mode = { kind: 'readonly', reason: decoded.reason, schema: decoded.head.v };
        break;
      case 'inconsistent':
        // Never treat the undecoded head as our base: our next write would claim to include it.
        this.base = mirror?.base ?? emptyLayout();
        this.baseHead = mirror?.baseHead ?? null;
        this.trustedBase = !!mirror?.base;
        if (this.trustedBase) this.scheduleRepair();
        else this.settleUntil = this.deps.timers.now() + SETTLE_MS;
        break;
      case 'corrupt':
        this.base = mirror?.base ?? emptyLayout();
        this.baseHead = mirror?.baseHead ?? null;
        this.mode = { kind: 'corrupt', reason: decoded.reason };
        break;
    }
    this.recompute();
    if (this.pending.length || this.resetPending) this.scheduleFlush();
  }

  snapshot(): LayoutSnapshot {
    return { layout: this.current, version: { epoch: this.epoch, seq: this.seq }, sync: this.health(), editable: this.editable() };
  }

  private editable(): boolean {
    return this.mode.kind === 'ok' || this.mode.kind === 'error';
  }

  private health(): SyncHealth {
    switch (this.mode.kind) {
      case 'readonly':
        return { kind: 'readonly', reason: this.mode.reason, writtenBySchema: this.mode.schema };
      case 'corrupt':
        return { kind: 'error', message: `${this.mode.reason} Reset the synced layout in Options to start over.`, pending: this.pending.length > 0 };
      case 'error':
        return { kind: 'error', message: this.mode.message, pending: this.pending.length > 0 || this.resetPending };
      case 'ok':
        return { kind: 'ok', bytes: this.bytes, chunks: this.chunks, lastWriteAt: this.lastWriteAt, pending: this.pending.length > 0 || this.resetPending };
    }
  }

  private recompute(): void {
    this.current = applyOps(this.base, this.pending.map((e) => e.op), { inventory: this.deps.inventory() });
    this.seq++;
  }

  private emit(): void {
    this.deps.emit(this.snapshot());
  }

  /** Applies a batch atomically: if any operation is rejected, none are kept. */
  async apply(ops: LayoutOp[]): Promise<ApplyResult> {
    if (!this.editable()) {
      const health = this.health();
      const reason = health.kind === 'readonly' ? health.reason : health.kind === 'error' ? health.message : 'Layout is not editable.';
      return { ok: false, error: reason, snapshot: this.snapshot() };
    }
    if (!ops.every(isValidLayoutOp)) return { ok: false, error: 'Invalid layout change.', snapshot: this.snapshot() };
    const ctx = { inventory: this.deps.inventory() };
    let next = this.current;
    // Store the concrete form: inventory-dependent requests are pinned to what this device sees now, so a
    // later replay (rebase, restart, cleared inventory) can never widen their effect.
    const resolved: LayoutOp[] = [];
    for (const op of ops) {
      const concrete = resolveOp(next, op, ctx);
      const result = applyOp(next, concrete, ctx);
      if (!result.ok) return { ok: false, error: result.reason, snapshot: this.snapshot() };
      resolved.push(concrete);
      next = result.layout;
    }
    const at = this.deps.timers.now();
    this.pending.push(...resolved.map((op) => ({ op, revs: [], at })));
    this.current = next;
    this.seq++;
    await this.saveMirror();
    this.scheduleFlush();
    this.emit();
    return { ok: true, snapshot: this.snapshot() };
  }

  /** Explicit user action: replace the synced layout (also the way out of read-only/corrupt states). */
  reset(): Promise<LayoutSnapshot> {
    return this.serial(async () => {
      this.pending = [];
      this.recent = [];
      this.base = emptyLayout();
      this.trustedBase = true;
      this.resetPending = true;
      this.mode = { kind: 'ok' };
      this.settleUntil = 0;
      this.recompute();
      await this.saveMirror();
      await this.writeNow('reset');
      this.emit();
    }).then(() => this.snapshot());
  }

  /** Re-derive the view after the inventory changed (delete guards and cleanups depend on it). */
  inventoryChanged(): void {
    this.recompute();
    this.emit();
  }

  private async saveMirror(): Promise<void> {
    const mirror: Mirror = {
      pending: this.pending,
      recent: this.recent,
      ownRevs: this.ownRevs,
      base: this.trustedBase ? this.base : null,
      baseHead: this.baseHead,
      resetPending: this.resetPending,
    };
    await this.deps.local.set({ [MIRROR_KEY]: mirror });
  }

  private scheduleFlush(delay = DEBOUNCE_MS): void {
    const { timers } = this.deps;
    if (this.flushTimer !== null) timers.clearTimeout(this.flushTimer);
    const now = timers.now();
    const wait = Math.max(delay, this.lastFlushStart + MIN_SPACING_MS - now, this.settleUntil - now, this.budgetWait(now));
    if (wait > WAKE_THRESHOLD_MS) this.deps.wake?.(wait);
    this.flushTimer = timers.setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, wait);
  }

  private budgetWait(now: number): number {
    this.writeTimes = this.writeTimes.filter((t) => now - t < 3_600_000);
    if (this.writeTimes.length < HOURLY_WRITE_BUDGET) return 0;
    return this.writeTimes[0]! + 3_600_000 - now;
  }

  /** Flushes pending operations (also called when the worker is woken for a retry). */
  flush(): Promise<void> {
    return this.serial(() => this.writeNow('normal'));
  }

  private async writeNow(requested: WriteMode): Promise<void> {
    const mode: WriteMode = this.resetPending ? 'reset' : requested;
    if (mode === 'normal' && (this.pending.length === 0 || !this.editable())) return;
    const now = this.deps.timers.now();
    if (mode === 'normal' && (now < this.settleUntil || now - this.lastFlushStart < MIN_SPACING_MS || this.budgetWait(now) > 0)) {
      this.scheduleFlush(0);
      return;
    }

    let existing: Record<string, unknown>;
    try {
      existing = await this.deps.sync.get(null);
    } catch (error) {
      this.failWrite(error);
      return;
    }
    // Compare-and-set: only write on top of the document we are based on.
    if (mode !== 'reset') {
      const decoded = decodeSyncItems(existing);
      const actual = decoded.status === 'empty' ? null : decoded.status === 'corrupt' ? '?' : (decoded.head?.r ?? '?');
      const conflict = mode === 'repair' ? decoded.status !== 'inconsistent' : actual !== (this.baseHead?.r ?? null);
      if (conflict) {
        await this.adoptFromSync(existing, decoded);
        return;
      }
    }

    const flushedOps = this.pending.length;
    const layout = this.current;
    if (mode === 'normal' && this.baseHead && layoutsEqual(layout, this.base)) {
      // Pending edits are already contained in the synced document (e.g. replays that the other device
      // also applied): nothing to write, and writing anyway could keep two devices echoing each other.
      this.pending = this.pending.slice(flushedOps);
      await this.saveMirror();
      this.emit();
      return;
    }
    this.lastFlushStart = now;
    const rev = this.rev();
    const ancestors = this.baseHead && mode !== 'reset' ? [this.baseHead.r, ...this.baseHead.a] : [];
    let encoded: ReturnType<typeof encodeLayout>;
    try {
      encoded = encodeLayout(layout, { rev, now, schema: writeSchemaFor(mode === 'reset' ? null : this.baseHead), ancestors });
    } catch (error) {
      if (error instanceof SyncQuotaError) {
        this.mode = { kind: 'error', message: 'Your sections are too large for Chrome Sync. They are saved on this device only until you remove some.' };
        this.emit();
        return;
      }
      throw error;
    }
    try {
      const stale = staleChunkKeys(Object.keys(existing), encoded.chunkCount);
      // Mark our revision before writing so our own change event is recognised as an echo.
      this.lastWrittenRev = rev;
      await this.deps.sync.set(encoded.items);
      this.writeTimes.push(now);
      if (stale.length) {
        await this.deps.sync.remove(stale);
        this.writeTimes.push(now);
      }
    } catch (error) {
      this.failWrite(error);
      return;
    }
    this.lastWriteAt = now;
    this.base = layout;
    this.baseHead = headInfo(encoded.head);
    this.trustedBase = true;
    this.resetPending = false;
    this.bytes = encoded.bytes;
    this.chunks = encoded.chunkCount;
    this.ownRevs = [...this.ownRevs.filter((o) => now - o.at < RECENT_TTL_MS * 2), { rev, at: now }].slice(-MAX_OWN_REVS);
    this.recent = [
      ...this.recent.filter((r) => now - r.at < RECENT_TTL_MS),
      ...this.pending.slice(0, flushedOps).map((e) => ({ op: e.op, revs: [...e.revs, rev].slice(-MAX_REVS_PER_OP), at: now })),
    ];
    this.pending = this.pending.slice(flushedOps);
    this.clearRepair();
    if (this.mode.kind === 'error' || this.mode.kind === 'corrupt') this.mode = { kind: 'ok' };
    this.recompute();
    await this.saveMirror();
    this.emit();
    if (this.pending.length) this.scheduleFlush();
  }

  private failWrite(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.mode = { kind: 'error', message: `Chrome Sync did not accept the change (${message.slice(0, 120)}). It is saved on this device and will be retried.` };
    this.emit();
    this.scheduleFlush(RETRY_MS);
  }

  /** Called for every chrome.storage.sync change; reads the whole document after the burst settles. */
  onSyncChanged(changedKeys: string[]): void {
    if (!changedKeys.some((k) => k.startsWith(SYNC_PREFIX))) return;
    const { timers } = this.deps;
    if (this.remoteTimer !== null) timers.clearTimeout(this.remoteTimer);
    this.remoteTimer = timers.setTimeout(() => {
      this.remoteTimer = null;
      void this.reloadFromSync();
    }, REMOTE_DEBOUNCE_MS);
  }

  reloadFromSync(): Promise<void> {
    return this.serial(async () => {
      const items = await this.deps.sync.get(null);
      await this.adoptFromSync(items, decodeSyncItems(items));
    });
  }

  /** Takes in whatever sync holds now. Runs inside the serial queue. */
  private async adoptFromSync(items: Record<string, unknown>, decoded: DecodeResult): Promise<void> {
    if (this.resetPending) {
      this.scheduleFlush(); // the reset is written first; later documents are rebased onto it by their devices
      return;
    }
    switch (decoded.status) {
      case 'ok': {
        if (decoded.head.r === this.lastWrittenRev && this.baseHead?.r === decoded.head.r) return; // our own echo
        this.adoptDocument(decoded.layout, decoded.head, items);
        this.settleUntil = 0; // another device's layout has arrived: stop holding writes
        // A failing write of ours stays visible until it succeeds; everything else is resolved by a good document.
        if (this.mode.kind !== 'error' || this.pending.length === 0) this.mode = { kind: 'ok' };
        this.clearRepair();
        break;
      }
      case 'empty':
        if (this.baseHead === null && this.mode.kind === 'ok') {
          if (this.pending.length) this.scheduleFlush();
          return;
        }
        // Reset from another device (or Options): start from an empty layout, keep local pending edits.
        this.base = emptyLayout();
        this.baseHead = null;
        this.trustedBase = true;
        this.mode = { kind: 'ok' };
        this.clearRepair();
        break;
      case 'inconsistent':
        if (this.trustedBase) this.scheduleRepair();
        return;
      case 'readonly':
        this.base = decoded.layout ?? this.base;
        this.baseHead = headInfo(decoded.head);
        this.mode = { kind: 'readonly', reason: decoded.reason, schema: decoded.head.v };
        this.clearRepair();
        break;
      case 'corrupt':
        this.mode = { kind: 'corrupt', reason: decoded.reason };
        break;
    }
    this.recompute();
    await this.saveMirror();
    this.emit();
    if ((this.pending.length || this.resetPending) && this.editable()) this.scheduleFlush();
  }

  private adoptDocument(layout: Layout, head: SyncHead, items: Record<string, unknown>): void {
    this.base = layout;
    this.baseHead = headInfo(head);
    this.trustedBase = true;
    this.adoptRemoteLineage(head);
    this.measure(items);
  }

  /**
   * Our documents are cumulative: a document that descends from a revision we wrote contains every operation we
   * wrote up to that revision. So an operation is acknowledged when one of its own revisions is in the lineage,
   * or when the lineage holds any of our revisions written at or after it. Everything else was overwritten by a
   * concurrent write and is replayed (before newer pending operations) on top of the incoming document.
   */
  private adoptRemoteLineage(head: SyncHead): void {
    const lineage = new Set([head.r, ...head.a]);
    let acknowledgedUpTo = -Infinity;
    for (const own of this.ownRevs) if (lineage.has(own.rev)) acknowledgedUpTo = Math.max(acknowledgedUpTo, own.at);
    const now = this.deps.timers.now();
    const unacknowledged = this.recent.filter((r) => r.at > acknowledgedUpTo && !r.revs.some((rev) => lineage.has(rev)) && now - r.at < RECENT_TTL_MS);
    this.recent = [];
    if (unacknowledged.length) this.pending = [...unacknowledged, ...this.pending];
  }

  private measure(items: Record<string, unknown>): void {
    const head = items[HEAD_KEY] as { n?: number } | undefined;
    this.chunks = typeof head?.n === 'number' ? head.n : 0;
    let bytes = 0;
    for (const [key, value] of Object.entries(items)) if (key.startsWith(SYNC_PREFIX)) bytes += itemBytes(key, value);
    this.bytes = bytes;
  }

  private scheduleRepair(): void {
    if (this.repairTimer !== null) return;
    const jitter = Math.floor((this.deps.random ?? Math.random)() * 5000);
    this.repairTimer = this.deps.timers.setTimeout(() => {
      this.repairTimer = null;
      void this.serial(() => this.repair());
    }, REPAIR_MS + jitter);
  }

  private clearRepair(): void {
    if (this.repairTimer !== null) this.deps.timers.clearTimeout(this.repairTimer);
    this.repairTimer = null;
  }

  /** A write that stays half-delivered (two devices racing on chunk keys) is replaced by our last good layout. */
  private async repair(): Promise<void> {
    if (!this.editable() || !this.trustedBase) return;
    this.lastFlushStart = -Infinity;
    await this.writeNow('repair');
  }
}

function headInfo(head: SyncHead | HeadInfo): HeadInfo {
  return { v: head.v, c: head.c, n: head.n, r: head.r, a: head.a.slice(), t: head.t };
}

function parseEntries(value: unknown): OpEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e): e is OpEntry =>
      !!e && typeof e === 'object' && Array.isArray((e as OpEntry).revs) && (e as OpEntry).revs.every((r) => typeof r === 'string') && typeof (e as OpEntry).at === 'number' && isValidLayoutOp((e as OpEntry).op),
  );
}

function parseHeadInfo(value: unknown): HeadInfo | null {
  if (!value || typeof value !== 'object') return null;
  const h = value as Partial<HeadInfo>;
  if (typeof h.v !== 'number' || typeof h.c !== 'number' || typeof h.n !== 'number' || typeof h.r !== 'string' || typeof h.t !== 'number') return null;
  return { v: h.v, c: h.c, n: h.n, r: h.r, t: h.t, a: Array.isArray(h.a) ? h.a.filter((r): r is string => typeof r === 'string') : [] };
}

function parseMirror(value: unknown): Mirror | null {
  if (!value || typeof value !== 'object') return null;
  const m = value as Partial<Mirror>;
  const base = m.base && typeof m.base === 'object' && Array.isArray(m.base.sections) ? m.base : null;
  const ownRevs = Array.isArray(m.ownRevs) ? m.ownRevs.filter((o): o is OwnRev => !!o && typeof o.rev === 'string' && typeof o.at === 'number') : [];
  return {
    pending: parseEntries(m.pending),
    recent: parseEntries(m.recent),
    ownRevs,
    base,
    baseHead: parseHeadInfo(m.baseHead),
    resetPending: m.resetPending === true,
  };
}
