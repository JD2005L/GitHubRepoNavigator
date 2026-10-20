import { describe, expect, it } from 'vitest';
import { DEBOUNCE_MS, LayoutStore, SETTLE_MS } from '../../src/background/layoutStore';
import { keysUnder, namespaced, ownKeys } from '../../src/background/namespacedArea';
import { decodeSyncItems } from '../../src/shared/layout/codec';
import { UNCATEGORIZED_ID, type LayoutOp } from '../../src/shared/layout/model';
import type { Broadcast, NavState } from '../../src/shared/messages';
import { ContentStore, type Transport } from '../../src/content/store';
import { FakeArea, ManualTimers } from '../helpers/fakeStorage';
import { ACCOUNT_ID, navState } from '../helpers/dom';

describe('namespaced storage', () => {
  it('reads and writes one prefix, and a whole-area read sees only that prefix', async () => {
    const area = new FakeArea('local');
    await area.set({ shared: 1, 'acct.1.a': 'one', 'acct.2.a': 'two' });
    const one = namespaced(area, 'acct.1.');
    expect(await one.get(null)).toEqual({ a: 'one' });
    expect(await one.get('a')).toEqual({ a: 'one' });
    await one.set({ b: true });
    await one.remove('a');
    expect(area.raw()).toEqual({ shared: 1, 'acct.1.b': true, 'acct.2.a': 'two' });
    expect(await keysUnder(area, 'acct.2.')).toEqual(['acct.2.a']);
  });

  it('leaves the area itself for the empty prefix', () => {
    const area = new FakeArea('local');
    expect(namespaced(area, '')).toBe(area);
    expect(ownKeys('', ['a', 'grn@2/b'])).toEqual(['a', 'grn@2/b']);
    expect(ownKeys('grn@2/', ['a', 'grn@2/b'])).toEqual(['b']);
  });
});

describe('a synced layout per account', () => {
  const create = (id: string, name: string): LayoutOp => ({ type: 'createSection', sectionId: id, name, beforeSectionId: UNCATEGORIZED_ID });

  async function store(sync: FakeArea, timers: ManualTimers, prefix: string, name: string): Promise<LayoutStore> {
    let n = 0;
    const layout = new LayoutStore({
      sync: namespaced(sync, prefix),
      local: namespaced(new FakeArea('local'), 'acct.x.'),
      timers,
      inventory: () => new Set([1, 2, 3]),
      emit: () => undefined,
      newRevision: () => `${name}${++n}`,
    });
    sync.onChanged((changes) => layout.onSyncChanged(ownKeys(prefix, Object.keys(changes))));
    await layout.init();
    return layout;
  }

  it('keeps each account’s sections apart in one Chrome Sync area, the first account’s where 1.2 kept it', async () => {
    const timers = new ManualTimers();
    const sync = new FakeArea('sync', () => timers.now());
    const first = await store(sync, timers, '', 'a');
    const second = await store(sync, timers, 'grn@2002/', 'b');
    await first.apply([create('home', 'Home')]);
    await second.apply([create('work', 'Work')]);
    await timers.advance(SETTLE_MS + DEBOUNCE_MS * 3);
    const raw = sync.raw();
    const legacy = decodeSyncItems(raw);
    const work = decodeSyncItems(Object.fromEntries(Object.entries(raw).flatMap(([k, v]) => (k.startsWith('grn@2002/') ? [[k.slice(9), v]] : []))));
    expect(legacy.status === 'ok' && legacy.layout.sections.map((s) => s.name)).toEqual(['Home', 'Uncategorized']);
    expect(work.status === 'ok' && work.layout.sections.map((s) => s.name)).toEqual(['Work', 'Uncategorized']);
    expect(first.snapshot().layout.sections.map((s) => s.name)).toEqual(['Home', 'Uncategorized']);
    expect(second.snapshot().layout.sections.map((s) => s.name)).toEqual(['Work', 'Uncategorized']);
    expect(first.snapshot().sync.kind).toBe('ok');
    expect(second.snapshot().sync.kind).toBe('ok');
  });
});

describe('ContentStore with more than one account', () => {
  function backend(state: NavState) {
    const listeners = new Set<(m: Broadcast) => void>();
    let loads = 0;
    const transport: Transport = {
      send: (request) => {
        if (request.type === 'nav/get') loads++;
        return Promise.resolve({ ok: true, data: state });
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    return { transport, broadcast: (m: Broadcast) => listeners.forEach((l) => l(m)), loads: () => loads };
  }

  it('applies only its own account’s changes, and asks again when accounts are connected or disconnected', async () => {
    const state = navState();
    const fake = backend(state);
    const store = new ContentStore(fake.transport);
    await store.load();
    fake.broadcast({ type: 'nav/inventory', account: 2002, inventory: { ...state.inventory, repos: [] } });
    expect(store.view()!.inventory.repos.length).toBe(state.inventory.repos.length);
    fake.broadcast({ type: 'nav/auth', account: null, auth: { kind: 'authorizing', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', expiresAt: 1 } });
    expect(store.view()!.auth.kind).toBe('signed-in');
    fake.broadcast({ type: 'nav/inventory', account: ACCOUNT_ID, inventory: { ...state.inventory, repos: [] } });
    expect(store.view()!.inventory.repos).toEqual([]);
    expect(fake.loads()).toBe(1);
    fake.broadcast({ type: 'nav/accounts' });
    expect(fake.loads()).toBe(2);
  });
});
