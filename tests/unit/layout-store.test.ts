import { describe, expect, it } from 'vitest';
import { DEBOUNCE_MS, LayoutStore, MIN_SPACING_MS, MIRROR_KEY, REPAIR_MS, RETRY_MS, SETTLE_MS } from '../../src/background/layoutStore';
import { HEAD_KEY, decodeSyncItems } from '../../src/shared/layout/codec';
import { UNCATEGORIZED_ID, buildView, type LayoutOp } from '../../src/shared/layout/model';
import type { LayoutSnapshot } from '../../src/shared/types';
import { FakeArea, ManualTimers, SyncNetwork, settle } from '../helpers/fakeStorage';
import { makeRepos } from '../helpers/repos';

interface Device {
  store: LayoutStore;
  sync: FakeArea;
  local: FakeArea;
  inventory: Set<number>;
  emitted: LayoutSnapshot[];
  restart(): Promise<Device>;
}

const wakes: number[] = [];

async function device(name: string, timers: ManualTimers, inventory: number[], areas?: { sync: FakeArea; local: FakeArea }): Promise<Device> {
  const sync = areas?.sync ?? new FakeArea('sync', () => timers.now());
  const local = areas?.local ?? new FakeArea('local');
  const inv = new Set(inventory);
  const emitted: LayoutSnapshot[] = [];
  let n = 0;
  const store = new LayoutStore({
    sync,
    local,
    timers,
    inventory: () => inv,
    emit: (s) => emitted.push(s),
    newRevision: () => `${name}${++n}x${Math.floor(timers.now() / 1000)}`,
    wake: (ms) => wakes.push(ms),
    random: () => (name.charCodeAt(0) % 7) / 7,
  });
  sync.onChanged((changes) => store.onSyncChanged(Object.keys(changes)));
  await store.init();
  return { store, sync, local, inventory: inv, emitted, restart: () => device(`${name}r`, timers, inventory, { sync, local }) };
}

const create = (id: string, name: string): LayoutOp => ({ type: 'createSection', sectionId: id, name, beforeSectionId: UNCATEGORIZED_ID });
const move = (repoId: number, to: string, before: number | null = null): LayoutOp => ({ type: 'moveRepo', repoId, toSectionId: to, beforeRepoId: before });

function syncedLayout(area: FakeArea) {
  const decoded = decodeSyncItems(area.raw());
  if (decoded.status !== 'ok') throw new Error(`sync is ${decoded.status}`);
  return decoded.layout;
}

/** Fresh devices hold their first write for SETTLE_MS; tests that are not about that skip ahead. */
async function pastSettle(timers: ManualTimers) {
  await timers.advance(SETTLE_MS + DEBOUNCE_MS);
}

describe('LayoutStore', () => {
  it('coalesces a burst of drag operations into one sync write', async () => {
    const timers = new ManualTimers();
    const a = await device('a', timers, [1, 2, 3]);
    await a.store.apply([create('work', 'Work')]);
    await pastSettle(timers);
    const writesBefore = a.sync.writeLog.length;
    for (let i = 0; i < 50; i++) await a.store.apply([move(1 + (i % 3), 'work', null)]);
    await timers.advance(DEBOUNCE_MS - 1);
    expect(a.sync.writeLog.length).toBe(writesBefore);
    await timers.advance(MIN_SPACING_MS);
    expect(a.sync.writeLog.length).toBe(writesBefore + 1);
    expect(syncedLayout(a.sync).sections[0]!.repoIds).toHaveLength(3);
  });

  it('keeps writes bounded under continuous editing', async () => {
    const timers = new ManualTimers();
    const a = await device('a', timers, [1, 2]);
    await a.store.apply([create('work', 'Work')]);
    await pastSettle(timers);
    const start = a.sync.writeLog.length;
    for (let s = 0; s < 600; s++) {
      await a.store.apply([move(s % 2 ? 1 : 2, 'work', null)]);
      await timers.advance(1000);
    }
    await timers.advance(10_000);
    const writes = a.sync.writeLog.slice(start);
    expect(writes.length).toBeLessThanOrEqual(600 / (MIN_SPACING_MS / 1000) + 1);
    for (const w of writes) expect(writes.filter((x) => x.at > w.at - 60_000 && x.at <= w.at).length).toBeLessThanOrEqual(30);
    expect(a.store.snapshot().sync.kind).toBe('ok');
  });

  it('mirrors accepted edits locally before syncing, so a worker restart cannot lose them', async () => {
    const timers = new ManualTimers();
    const a = await device('a', timers, [1]);
    await pastSettle(timers);
    await a.store.apply([create('work', 'Work'), move(1, 'work')]);
    expect((a.local.raw()[MIRROR_KEY] as { pending: unknown[] }).pending).toHaveLength(2);
    expect(a.sync.raw()[HEAD_KEY]).toBeUndefined();
    // Worker dies before the debounce fires.
    const restarted = await a.restart();
    expect(restarted.store.snapshot().layout.sections[0]).toMatchObject({ id: 'work', repoIds: [1] });
    await timers.advance(SETTLE_MS + DEBOUNCE_MS + MIN_SPACING_MS);
    expect(syncedLayout(a.sync).sections[0]).toMatchObject({ id: 'work', repoIds: [1] });
  });

  it('applies a batch atomically', async () => {
    const timers = new ManualTimers();
    const a = await device('a', timers, [1]);
    const result = await a.store.apply([create('work', 'Work'), { type: 'renameSection', sectionId: 'missing', name: 'x' }]);
    expect(result.ok).toBe(false);
    expect(a.store.snapshot().layout.sections.map((s) => s.id)).toEqual([UNCATEGORIZED_ID]);
  });

  it('applies the synced sections to a second device with a different inventory', async () => {
    const timers = new ManualTimers();
    const repos = makeRepos(10);
    const ids = repos.map((r) => r.id);
    const a = await device('a', timers, ids.slice(0, 8));
    const b = await device('b', timers, ids.slice(2, 10));
    const net = new SyncNetwork([a.sync, b.sync]);
    await a.store.apply([create('work', 'Work'), move(ids[0]!, 'work'), move(ids[3]!, 'work'), move(ids[5]!, 'work')]);
    await pastSettle(timers);
    net.deliver();
    await timers.advance(1000);
    const onB = b.store.snapshot().layout;
    expect(onB.sections[0]).toMatchObject({ id: 'work', name: 'Work', repoIds: [ids[0], ids[3], ids[5]] });
    const viewB = buildView(onB, repos.slice(2, 10));
    expect(viewB[0]!.repos.map((r) => r.id)).toEqual([ids[3], ids[5]]); // ids[0] is not visible on B
    expect(viewB[0]!.unavailable).toBe(1);
    // An edit on B must keep A's repository that B cannot see.
    await b.store.apply([move(ids[9]!, 'work', ids[3])]);
    await timers.advance(DEBOUNCE_MS + MIN_SPACING_MS);
    net.deliver();
    await timers.advance(1000);
    expect(a.store.snapshot().layout.sections[0]!.repoIds).toEqual([ids[0], ids[9], ids[3], ids[5]]);
  });

  it('keeps the last good layout while a chunked write is only partly delivered', async () => {
    const timers = new ManualTimers();
    const many = Array.from({ length: 1500 }, (_, i) => 900_000_000 + i * 977);
    const a = await device('a', timers, many);
    const b = await device('b', timers, many);
    const net = new SyncNetwork([a.sync, b.sync]);
    await a.store.apply([create('one', 'One')]);
    await pastSettle(timers);
    net.deliver();
    await timers.advance(1000);
    expect(b.store.snapshot().layout.sections[0]!.id).toBe('one');

    await a.store.apply([create('big', 'Big'), ...many.map((id) => move(id, 'big'))]);
    await timers.advance(DEBOUNCE_MS + MIN_SPACING_MS);
    expect((a.sync.raw()[HEAD_KEY] as { n: number }).n).toBeGreaterThan(1);
    net.deliver((m) => m.key === HEAD_KEY); // head arrives first, chunks later
    await timers.advance(1000);
    expect(b.store.snapshot().layout.sections.map((s) => s.id)).toEqual(['one', UNCATEGORIZED_ID]);
    net.deliver();
    await timers.advance(1000);
    expect(b.store.snapshot().layout.sections.map((s) => s.id)).toEqual(['one', 'big', UNCATEGORIZED_ID]);
    expect(b.store.snapshot().layout.sections[1]!.repoIds).toHaveLength(1500);
  });

  it('repairs a document that stays inconsistent (devices raced on chunk keys)', async () => {
    const timers = new ManualTimers();
    const a = await device('a', timers, [1]);
    await a.store.apply([create('one', 'One')]);
    await pastSettle(timers);
    // Simulate a head from another device whose chunks never arrive.
    a.sync.applyRaw({ [HEAD_KEY]: JSON.stringify({ v: 1, c: 1, n: 2, r: 'zzz', a: [], t: 1, d: '{"s":[' }) });
    await timers.advance(1000);
    expect(a.store.snapshot().layout.sections[0]!.id).toBe('one');
    await timers.advance(REPAIR_MS + 5000);
    expect(decodeSyncItems(a.sync.raw()).status).toBe('ok');
    expect(syncedLayout(a.sync).sections[0]!.id).toBe('one');
  });

  it('keeps both edits when two devices change different things at the same time', async () => {
    const timers = new ManualTimers();
    const a = await device('a', timers, [1, 2, 3]);
    const b = await device('b', timers, [1, 2, 3]);
    const net = new SyncNetwork([a.sync, b.sync]);
    await a.store.apply([create('work', 'Work'), create('play', 'Play')]);
    await pastSettle(timers);
    net.deliver();
    await timers.advance(1000);

    await a.store.apply([move(1, 'work')]);
    await b.store.apply([move(2, 'play'), { type: 'setCollapsed', sectionId: 'work', collapsed: true }]);
    await timers.advance(DEBOUNCE_MS + MIN_SPACING_MS); // both write before hearing from each other
    const writesBefore = a.sync.writeLog.length + b.sync.writeLog.length;
    let rounds = 0;
    while (net.deliver() > 0) {
      await timers.advance(30_000);
      if (++rounds > 6) throw new Error('devices never stopped rewriting each other');
    }
    expect(a.sync.writeLog.length + b.sync.writeLog.length - writesBefore).toBeLessThanOrEqual(2);

    for (const d of [a, b]) {
      const layout = d.store.snapshot().layout;
      expect(layout.sections.find((s) => s.id === 'work')).toMatchObject({ repoIds: [1], collapsed: true });
      expect(layout.sections.find((s) => s.id === 'play')).toMatchObject({ repoIds: [2] });
    }
    expect(syncedLayout(a.sync)).toEqual(syncedLayout(b.sync));
  });

  it('converges when two devices make conflicting edits at the same time', async () => {
    const timers = new ManualTimers();
    const a = await device('a', timers, [1, 2, 3]);
    const b = await device('b', timers, [1, 2, 3]);
    const net = new SyncNetwork([a.sync, b.sync]);
    await a.store.apply([create('s1', 'One'), create('s2', 'Two')]);
    await pastSettle(timers);
    net.deliver();
    await timers.advance(30_000);

    await a.store.apply([move(1, 's1'), { type: 'renameSection', sectionId: 's2', name: 'From A' }]);
    await b.store.apply([move(1, 's2'), { type: 'renameSection', sectionId: 's2', name: 'From B' }, move(3, 's1')]);
    await timers.advance(DEBOUNCE_MS + MIN_SPACING_MS);
    let rounds = 0;
    while (net.deliver() > 0) {
      await timers.advance(30_000);
      if (++rounds > 6) throw new Error('devices never stopped rewriting each other');
    }
    const finalA = a.store.snapshot().layout;
    expect(b.store.snapshot().layout).toEqual(finalA);
    expect(syncedLayout(a.sync)).toEqual(finalA);
    expect(syncedLayout(b.sync)).toEqual(finalA);
    expect(finalA.sections.flatMap((s) => s.repoIds).filter((id) => id === 1)).toHaveLength(1);
    expect(finalA.sections.find((s) => s.id === 's1')!.repoIds).toContain(3); // non-conflicting edit kept
  });

  it('rebases early edits on a fresh device onto the layout that arrives from sync', async () => {
    const timers = new ManualTimers();
    const a = await device('a', timers, [1, 2]);
    await a.store.apply([create('work', 'Work'), move(1, 'work')]);
    await pastSettle(timers);
    // B installs later; Chrome Sync has not delivered A's layout yet.
    const b = await device('b', timers, [1, 2]);
    const net = new SyncNetwork([a.sync, b.sync]);
    await b.store.apply([create('mine', 'Mine'), move(2, 'mine')]);
    await timers.advance(DEBOUNCE_MS + MIN_SPACING_MS);
    expect(b.sync.raw()[HEAD_KEY]).toBeUndefined(); // still settling: nothing written
    // A's existing document reaches B.
    for (const [key, value] of Object.entries(a.sync.raw())) b.sync.applyRaw({ [key]: JSON.stringify(value) });
    await timers.advance(SETTLE_MS);
    const layout = syncedLayout(b.sync);
    expect(layout.sections.map((s) => s.id)).toEqual(['work', 'mine', UNCATEGORIZED_ID]);
    expect(layout.sections[0]!.repoIds).toEqual([1]);
    expect(net.outbox.length).toBeGreaterThan(0);
  });

  it('never writes over a document from a newer, incompatible schema', async () => {
    const timers = new ManualTimers();
    const sync = new FakeArea('sync', () => timers.now());
    sync.applyRaw({ [HEAD_KEY]: JSON.stringify({ v: 3, c: 3, n: 1, r: 'future', a: [], t: 1, d: JSON.stringify({ s: [['a', 'From the future', 0, '1']] }) }) });
    const a = await device('a', timers, [1], { sync, local: new FakeArea('local') });
    expect(a.store.snapshot()).toMatchObject({ editable: false, sync: { kind: 'readonly' } });
    expect(a.store.snapshot().layout.sections[0]!.name).toBe('From the future');
    const result = await a.store.apply([create('x', 'X')]);
    expect(result.ok).toBe(false);
    await timers.advance(60_000);
    expect(sync.writeLog).toHaveLength(0);
  });

  it('does not overwrite a corrupt document until the user resets', async () => {
    const timers = new ManualTimers();
    const sync = new FakeArea('sync', () => timers.now());
    sync.applyRaw({ [HEAD_KEY]: JSON.stringify({ v: 1, c: 1, n: 1, r: 'bad', a: [], t: 1, d: '{"s":' }) });
    const a = await device('a', timers, [1], { sync, local: new FakeArea('local') });
    expect(a.store.snapshot()).toMatchObject({ editable: false, sync: { kind: 'error' } });
    await timers.advance(60_000);
    expect(sync.writeLog).toHaveLength(0);
    await a.store.reset();
    expect(decodeSyncItems(sync.raw()).status).toBe('ok');
    expect(a.store.snapshot().editable).toBe(true);
  });

  it('surfaces a rejected sync write, keeps the edit and retries', async () => {
    const timers = new ManualTimers();
    const a = await device('a', timers, [1]);
    await pastSettle(timers);
    a.sync.failNext = new Error('MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded');
    await a.store.apply([create('work', 'Work')]);
    await timers.advance(DEBOUNCE_MS + MIN_SPACING_MS);
    expect(a.store.snapshot().sync).toMatchObject({ kind: 'error', pending: true });
    expect(a.store.snapshot().layout.sections[0]!.id).toBe('work');
    await timers.advance(RETRY_MS + MIN_SPACING_MS);
    expect(a.store.snapshot().sync.kind).toBe('ok');
    expect(syncedLayout(a.sync).sections[0]!.id).toBe('work');
  });

  it('follows a reset made on another device', async () => {
    const timers = new ManualTimers();
    const a = await device('a', timers, [1]);
    const b = await device('b', timers, [1]);
    const net = new SyncNetwork([a.sync, b.sync]);
    await a.store.apply([create('work', 'Work')]);
    await pastSettle(timers);
    net.deliver();
    await timers.advance(1000);
    expect(b.store.snapshot().layout.sections[0]!.id).toBe('work');
    await a.store.reset();
    net.deliver();
    await timers.advance(1000);
    expect(b.store.snapshot().layout.sections.map((s) => s.id)).toEqual([UNCATEGORIZED_ID]);
    await settle();
  });

  it('pins "forget unavailable" to the IDs unavailable at the time, even if the inventory is cleared before the flush', async () => {
    const timers = new ManualTimers();
    const a = await device('a', timers, [1, 2]);
    await a.store.apply([create('work', 'Work'), move(1, 'work'), move(99, 'work')]);
    await pastSettle(timers);
    expect(syncedLayout(a.sync).sections[0]!.repoIds).toEqual([1, 99]);
    const result = await a.store.apply([{ type: 'removeUnavailable' }]);
    expect(result.ok).toBe(true);
    const pending = (a.local.raw()[MIRROR_KEY] as { pending: { op: LayoutOp }[] }).pending;
    expect(pending.map((e) => e.op)).toEqual([{ type: 'unassign', repoIds: [99] }]);
    // The user disconnects (inventory cleared) before the debounced write happens.
    a.inventory.clear();
    a.store.inventoryChanged();
    await timers.advance(DEBOUNCE_MS + MIN_SPACING_MS);
    expect(syncedLayout(a.sync).sections[0]!.repoIds).toEqual([1]);
    // And the request itself is refused against an empty inventory.
    expect((await a.store.apply([{ type: 'removeUnavailable' }])).ok).toBe(false);
  });

  it('does not let a replayed delete drop repositories another device placed in the section meanwhile', async () => {
    const timers = new ManualTimers();
    const a = await device('a', timers, [1]); // cannot see 7
    const b = await device('b', timers, [1, 7]);
    const net = new SyncNetwork([a.sync, b.sync]);
    await a.store.apply([create('work', 'Work')]);
    await pastSettle(timers);
    net.deliver();
    await timers.advance(30_000);
    // Concurrently: A deletes the (empty-looking) section, B puts repository 7 into it.
    await a.store.apply([{ type: 'deleteSection', sectionId: 'work' }]);
    await b.store.apply([move(7, 'work')]);
    await timers.advance(DEBOUNCE_MS + MIN_SPACING_MS);
    let rounds = 0;
    while (net.deliver() > 0) {
      await timers.advance(30_000);
      if (++rounds > 6) throw new Error('no convergence');
    }
    for (const d of [a, b]) expect(d.store.snapshot().layout.sections.find((s) => s.id === 'work')?.repoIds).toEqual([7]);
  });

  it('never reverts newer edits after many writes and a worker restart (acknowledgement by write order)', async () => {
    const timers = new ManualTimers();
    const a = await device('a', timers, [1, 2]);
    await a.store.apply([create('s1', 'One'), create('s2', 'Two'), move(1, 's1')]);
    await pastSettle(timers);
    for (let i = 0; i < 20; i++) {
      await a.store.apply([{ type: 'setCollapsed', sectionId: 's2', collapsed: i % 2 === 0 }]);
      await timers.advance(DEBOUNCE_MS + MIN_SPACING_MS);
    }
    await a.store.apply([move(1, 's2')]);
    await timers.advance(DEBOUNCE_MS + MIN_SPACING_MS);
    expect(syncedLayout(a.sync).sections.find((s) => s.id === 's2')!.repoIds).toEqual([1]);
    const restarted = await a.restart();
    expect(restarted.store.snapshot().layout.sections.find((s) => s.id === 's2')!.repoIds).toEqual([1]);
    await timers.advance(60_000);
    expect(syncedLayout(a.sync).sections.find((s) => s.id === 's2')!.repoIds).toEqual([1]);
    expect(syncedLayout(a.sync).sections.find((s) => s.id === 's1')!.repoIds).toEqual([]);
  });

  it('does not claim to descend from a partially delivered document it never decoded', async () => {
    const timers = new ManualTimers();
    const many = Array.from({ length: 1500 }, (_, i) => 900_000_000 + i * 977);
    const a = await device('a', timers, [1, ...many]);
    const b = await device('b', timers, [1, ...many]);
    const net = new SyncNetwork([a.sync, b.sync]);
    await a.store.apply([create('one', 'One')]);
    await pastSettle(timers);
    net.deliver();
    await timers.advance(30_000);
    // B writes a big (chunked) document; only its head reaches A, then A's worker restarts.
    await b.store.apply([create('big', 'Big'), ...many.map((id) => move(id, 'big'))]);
    await timers.advance(DEBOUNCE_MS + MIN_SPACING_MS);
    const bRev = (b.sync.raw()[HEAD_KEY] as { r: string }).r;
    net.deliver((m) => m.key === HEAD_KEY);
    const a2 = await a.restart();
    a2.sync.onChanged((changes) => a2.store.onSyncChanged(Object.keys(changes)));
    await a2.store.apply([move(1, 'one')]);
    await timers.advance(DEBOUNCE_MS + MIN_SPACING_MS);
    // A must not have written on top of the half-delivered document.
    expect((a.sync.raw()[HEAD_KEY] as { r: string }).r).toBe(bRev);
    net.push();
    await timers.advance(30_000);
    let rounds = 0;
    while (net.deliver() > 0) {
      await timers.advance(30_000);
      if (++rounds > 6) throw new Error('no convergence');
    }
    const final = syncedLayout(a.sync);
    expect(final.sections.find((s) => s.id === 'big')!.repoIds).toHaveLength(1500);
    expect(final.sections.find((s) => s.id === 'one')!.repoIds).toEqual([1]);
  });

  it('never repairs from an empty base on a fresh device that only saw half a document', async () => {
    const timers = new ManualTimers();
    const sync = new FakeArea('sync', () => timers.now());
    sync.applyRaw({ [HEAD_KEY]: JSON.stringify({ v: 1, c: 1, n: 2, r: 'other', a: [], t: 1, d: '{"s":[' }) });
    await device('a', timers, [1], { sync, local: new FakeArea('local') });
    await timers.advance(REPAIR_MS * 4);
    expect(sync.writeLog).toHaveLength(0);
  });

  it('does not clobber a document that arrives just before a flush (compare-and-set)', async () => {
    const timers = new ManualTimers();
    const a = await device('a', timers, [1]);
    await a.store.apply([create('work', 'Work')]);
    await pastSettle(timers);
    await a.store.apply([{ type: 'renameSection', sectionId: 'work', name: 'Job' }]);
    await timers.advance(DEBOUNCE_MS - 100);
    const future = { v: 3, c: 3, n: 1, r: 'future', a: [], t: 1, d: JSON.stringify({ s: [['work', 'From v3', 0, '']], v3only: { x: 1 } }) };
    a.sync.applyRaw({ [HEAD_KEY]: JSON.stringify(future) }); // remote write lands 100 ms before our flush
    await timers.advance(MIN_SPACING_MS + 1000);
    expect(a.sync.raw()[HEAD_KEY]).toEqual(future);
    expect(a.store.snapshot()).toMatchObject({ editable: false, sync: { kind: 'readonly' } });
  });

  it('retries a reset whose write failed, and arms a wake-up for long retries', async () => {
    const timers = new ManualTimers();
    const a = await device('a', timers, [1]);
    await a.store.apply([create('work', 'Work'), move(1, 'work')]);
    await pastSettle(timers);
    a.sync.failNext = new Error('This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.');
    wakes.length = 0;
    await a.store.reset();
    expect(syncedLayout(a.sync).sections[0]!.id).toBe('work'); // not yet
    expect(wakes.some((ms) => ms >= RETRY_MS)).toBe(true);
    const restarted = await a.restart(); // the worker was terminated while waiting
    expect(restarted.store.snapshot().layout.sections.map((s) => s.id)).toEqual([UNCATEGORIZED_ID]);
    await timers.advance(DEBOUNCE_MS + MIN_SPACING_MS);
    expect(syncedLayout(a.sync).sections.map((s) => s.id)).toEqual([UNCATEGORIZED_ID]);
  });

  it('drops malformed operations from the mirror instead of failing to start', async () => {
    const timers = new ManualTimers();
    const local = new FakeArea('local');
    local.applyRaw({
      [MIRROR_KEY]: JSON.stringify({
        pending: [
          { op: { type: 'createSection', sectionId: 'work', name: 42, beforeSectionId: null }, revs: [], at: 1 },
          { op: { type: 'createSection', sectionId: 'ok', name: 'Fine', beforeSectionId: null }, revs: [], at: 1 },
        ],
        recent: [],
      }),
    });
    const a = await device('a', timers, [1], { sync: new FakeArea('sync', () => timers.now()), local });
    expect(a.store.snapshot().layout.sections.map((s) => s.id)).toEqual([UNCATEGORIZED_ID, 'ok']);
    expect((await a.store.apply([{ type: 'createSection', sectionId: 'x', name: 42 } as unknown as LayoutOp])).ok).toBe(false);
  });

  it('stores only the layout in sync', async () => {
    const timers = new ManualTimers();
    const a = await device('a', timers, [1]);
    await a.store.apply([create('work', 'Work'), move(1, 'work')]);
    await pastSettle(timers);
    expect(a.sync.keys().every((k) => k.startsWith('grn:'))).toBe(true);
    expect(JSON.stringify(a.sync.raw())).not.toMatch(/ghu_|ghr_|token|avatar|github\.com/i);
  });
});
