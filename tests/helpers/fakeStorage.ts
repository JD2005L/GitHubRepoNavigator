import type { StorageAreaLike, Timers } from '../../src/background/layoutStore';
import { itemBytes } from '../../src/shared/layout/codec';

type Change = { oldValue?: unknown; newValue?: unknown };
type Listener = (changes: Record<string, Change>) => void;


/**
 * In-memory chrome.storage area. Values are stored as JSON (like Chrome) so tests cannot accidentally share
 * object references. The sync variant enforces Chrome's documented quotas.
 */
export class FakeArea implements StorageAreaLike {
  private data = new Map<string, string>();
  private listeners: Listener[] = [];
  writeLog: { at: number; keys: string[]; kind: 'set' | 'remove' }[] = [];
  failNext: Error | null = null;
  /** Called after a local set/remove with the per-key changes (used by the sync network). */
  onLocalWrite: ((changes: Record<string, Change>) => void) | null = null;

  constructor(
    readonly name: 'local' | 'sync' | 'session',
    private readonly clock: () => number = () => 0,
    readonly quotas = name === 'sync' ? { perItem: 8192, total: 102400, maxItems: 512, perMinute: 120, perHour: 1800 } : null,
  ) {}

  onChanged(listener: Listener): void {
    this.listeners.push(listener);
  }

  private fire(changes: Record<string, Change>): void {
    if (!Object.keys(changes).length) return;
    for (const l of this.listeners) queueMicrotask(() => l(changes));
  }

  get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const wanted = keys === null || keys === undefined ? [...this.data.keys()] : Array.isArray(keys) ? keys : [keys];
    for (const k of wanted) {
      const v = this.data.get(k);
      if (v !== undefined) out[k] = JSON.parse(v);
    }
    return Promise.resolve(out);
  }

  private checkWriteRate(): void {
    if (!this.quotas) return;
    const now = this.clock();
    const lastMinute = this.writeLog.filter((w) => now - w.at < 60_000).length;
    const lastHour = this.writeLog.filter((w) => now - w.at < 3_600_000).length;
    if (lastMinute >= this.quotas.perMinute) throw new Error('MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded');
    if (lastHour >= this.quotas.perHour) throw new Error('MAX_WRITE_OPERATIONS_PER_HOUR quota exceeded');
  }

  set(items: Record<string, unknown>): Promise<void> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      return Promise.reject(e);
    }
    try {
      this.checkWriteRate();
      if (this.quotas) {
        const next = new Map(this.data);
        for (const [k, v] of Object.entries(items)) {
          // Measured like Chrome (Chromium JSON escaping), not like JS JSON.stringify.
          const size = itemBytes(k, v);
          if (size > this.quotas.perItem) throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
          next.set(k, JSON.stringify(v));
        }
        let total = 0;
        for (const [k, v] of next) total += itemBytes(k, JSON.parse(v));
        if (total > this.quotas.total) throw new Error('QUOTA_BYTES quota exceeded');
        if (next.size > this.quotas.maxItems) throw new Error('MAX_ITEMS quota exceeded');
      }
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.writeLog.push({ at: this.clock(), keys: Object.keys(items), kind: 'set' });
    const changes = this.applyRaw(Object.fromEntries(Object.entries(items).map(([k, v]) => [k, JSON.stringify(v)])));
    this.onLocalWrite?.(changes);
    return Promise.resolve();
  }

  remove(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    try {
      this.checkWriteRate();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.writeLog.push({ at: this.clock(), keys: list, kind: 'remove' });
    const changes = this.applyRaw(Object.fromEntries(list.map((k) => [k, undefined])));
    this.onLocalWrite?.(changes);
    return Promise.resolve();
  }

  /** Applies serialized values (undefined = delete) and fires onChanged. */
  applyRaw(raw: Record<string, string | undefined>): Record<string, Change> {
    const changes: Record<string, Change> = {};
    for (const [k, v] of Object.entries(raw)) {
      const old = this.data.get(k);
      if (old === v) continue;
      if (v === undefined) this.data.delete(k);
      else this.data.set(k, v);
      changes[k] = { oldValue: old === undefined ? undefined : JSON.parse(old), newValue: v === undefined ? undefined : JSON.parse(v) };
    }
    this.fire(changes);
    return changes;
  }

  keys(): string[] {
    return [...this.data.keys()];
  }

  raw(): Record<string, unknown> {
    return Object.fromEntries([...this.data].map(([k, v]) => [k, JSON.parse(v)]));
  }
}

/**
 * Simulates Chrome Sync as a server holding one authoritative value per key (last committed write wins).
 * Local writes sit in an outbox until `commit()`; `push()` brings every device up to the server's values
 * for keys it has not seen yet (a device never receives its own latest write back). `deliver()` does both.
 * Filters let a test deliver only some keys, e.g. a head without its chunks.
 */
export class SyncNetwork {
  outbox: { from: FakeArea; key: string; value: string | undefined }[] = [];
  private server = new Map<string, { value: string | undefined; version: number }>();
  private known = new Map<FakeArea, Map<string, number>>();
  private version = 0;

  constructor(readonly devices: FakeArea[]) {
    for (const d of devices) {
      this.known.set(d, new Map());
      d.onLocalWrite = (changes) => {
        for (const [key, change] of Object.entries(changes)) {
          this.outbox.push({ from: d, key, value: change.newValue === undefined ? undefined : JSON.stringify(change.newValue) });
        }
      };
    }
  }

  commit(): number {
    const batch = this.outbox;
    this.outbox = [];
    for (const msg of batch) {
      this.version++;
      this.server.set(msg.key, { value: msg.value, version: this.version });
      this.known.get(msg.from)!.set(msg.key, this.version);
    }
    return batch.length;
  }

  push(filter: (msg: { key: string }) => boolean = () => true): number {
    let applied = 0;
    for (const d of this.devices) {
      const known = this.known.get(d)!;
      const updates: Record<string, string | undefined> = {};
      for (const [key, entry] of this.server) {
        if ((known.get(key) ?? 0) >= entry.version || !filter({ key })) continue;
        known.set(key, entry.version);
        updates[key] = entry.value;
        applied++;
      }
      if (Object.keys(updates).length) d.applyRaw(updates);
    }
    return applied;
  }

  /** Commits every queued write, then pushes the server state (optionally only matching keys). */
  deliver(filter?: (msg: { key: string }) => boolean): number {
    const committed = this.commit();
    return committed + this.push(filter);
  }

  serverValues(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of this.server) if (v.value !== undefined) out[k] = JSON.parse(v.value);
    return out;
  }
}

/** Deterministic timers: nothing runs until `advance()`. */
export class ManualTimers implements Timers {
  private t = 1_000_000;
  private nextId = 1;
  private tasks = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  pending(): number {
    return this.tasks.size;
  }

  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await settle();
      let nextId: number | null = null;
      let next: { at: number; fn: () => void } | null = null;
      for (const [id, task] of this.tasks) if (task.at <= end && (!next || task.at < next.at)) [nextId, next] = [id, task];
      if (!next || nextId === null) break;
      this.tasks.delete(nextId);
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = end;
    await settle();
  }
}

export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}
