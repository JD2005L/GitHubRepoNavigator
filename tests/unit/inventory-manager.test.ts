import { describe, expect, it } from 'vitest';
import { CACHE_KEY, ETAGS_KEY, InventoryManager, RATE_LIMIT_KEY } from '../../src/background/inventoryManager';
import type { FetchLike } from '../../src/background/github/client';
import type { InventorySnapshot } from '../../src/shared/types';
import { FakeArea, ManualTimers } from '../helpers/fakeStorage';
import { releaseFixture, type MockGitHub } from '../helpers/mockGithub';
import { apiRepo } from '../helpers/repos';

const bases = { apiBase: 'https://api.github.com', oauthBase: 'https://github.com' };

interface Harness {
  manager: InventoryManager;
  local: FakeArea;
  timers: ManualTimers;
  snapshots: InventorySnapshot[];
  auth: { signedIn: boolean; unauthorizedCalls: number; reason: 'transient' | null; refreshOnce: boolean };
}

async function harness(mock: MockGitHub, options: { local?: FakeArea; timers?: ManualTimers; fetch?: FetchLike } = {}): Promise<Harness> {
  const local = options.local ?? new FakeArea('local');
  const timers = options.timers ?? new ManualTimers();
  const snapshots: InventorySnapshot[] = [];
  const auth = { signedIn: true, unauthorizedCalls: 0, reason: null as 'transient' | null, refreshOnce: false };
  const manager = new InventoryManager({
    local,
    fetch: options.fetch ?? mock.fetch(bases),
    timers,
    apiBase: bases.apiBase,
    auth: {
      isSignedIn: () => auth.signedIn,
      token: () => Promise.resolve(auth.reason ? { reason: auth.reason } : { token: mock.issuedToken }),
      onUnauthorized: () => {
        auth.unauthorizedCalls++;
        return Promise.resolve(auth.refreshOnce && auth.unauthorizedCalls === 1);
      },
    },
    onChange: (s) => snapshots.push(s),
  });
  await manager.init();
  return { manager, local, timers, snapshots, auth };
}

describe('InventoryManager', () => {
  it('keeps the previous cache when a later refresh fails part-way', async () => {
    const mock = releaseFixture();
    const h = await harness(mock);
    await h.manager.refresh();
    expect(h.manager.snapshot().repos).toHaveLength(255);
    mock.failure = { kind: 'server-error', onPath: '/user/repos', afterPage: 2 };
    await h.manager.refresh({ force: true });
    expect(h.manager.snapshot().repos).toHaveLength(255);
    expect(h.manager.snapshot().status).toMatchObject({ kind: 'error' });
    expect((h.local.raw()[CACHE_KEY] as { repos: unknown[] }).repos).toHaveLength(255);
  });

  it('never writes back an inventory fetched before a sign-out', async () => {
    const mock = releaseFixture();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = mock.fetch(bases);
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.includes('page=2')) await gate; // hold the refresh in the middle
      return inner(url, init);
    };
    const h = await harness(mock, { fetch: fetchImpl });
    const running = h.manager.refresh();
    await new Promise((r) => setTimeout(r, 10));
    h.auth.signedIn = false;
    await h.manager.clear();
    release();
    await running;
    expect(h.local.raw()[CACHE_KEY]).toBeUndefined();
    expect(h.local.raw()[ETAGS_KEY]).toBeUndefined();
    expect(h.manager.snapshot().repos).toHaveLength(0);
  });

  it('remembers a rate limit across worker restarts and does not call GitHub until it resets', async () => {
    const mock = releaseFixture();
    const timers = new ManualTimers();
    const local = new FakeArea('local');
    const h = await harness(mock, { local, timers });
    mock.failure = { kind: 'rate-limit', resetEpochSeconds: Math.floor(timers.now() / 1000) + 3600 };
    await h.manager.refresh();
    expect(h.manager.snapshot().status.kind).toBe('rate-limited');
    expect(typeof local.raw()[RATE_LIMIT_KEY]).toBe('number');
    mock.failure = null;
    mock.log = [];
    const restarted = await harness(mock, { local, timers });
    expect(restarted.manager.snapshot().status.kind).toBe('rate-limited');
    await restarted.manager.refresh();
    expect(mock.log).toHaveLength(0);
    await restarted.manager.refresh({ force: true }); // the user's explicit "Refresh now"
    expect(restarted.manager.snapshot().repos).toHaveLength(255);
    expect(local.raw()[RATE_LIMIT_KEY]).toBeUndefined();
  });

  it('refreshes the token and retries once when GitHub answers 401 in the middle of pagination', async () => {
    const mock = releaseFixture();
    const inner = mock.fetch(bases);
    let failed = false;
    const fetchImpl: FetchLike = (url, init) => {
      if (!failed && url.includes('page=3')) {
        failed = true;
        return Promise.resolve(new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }));
      }
      return inner(url, init);
    };
    const h = await harness(mock, { fetch: fetchImpl });
    h.auth.refreshOnce = true;
    await h.manager.refresh();
    expect(h.auth.unauthorizedCalls).toBe(1);
    expect(h.manager.snapshot().repos).toHaveLength(255);
  });

  it('stores ETag pages as repository IDs and still rebuilds every page from 304s', async () => {
    const mock = releaseFixture();
    const local = new FakeArea('local');
    const h = await harness(mock, { local });
    await h.manager.refresh();
    const stored = local.raw()[ETAGS_KEY] as { format: number; pages: Record<string, { ids?: unknown[]; items?: unknown[] }> };
    expect(stored.format).toBeGreaterThan(0);
    const repoPages = Object.values(stored.pages).filter((p) => p.ids);
    expect(repoPages.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(stored)).not.toMatch(/nodeId|avatars/);
    mock.log = [];
    const restarted = await harness(mock, { local });
    await restarted.manager.refresh({ force: true });
    expect(mock.log.every((r) => r.status === 304)).toBe(true);
    expect(restarted.manager.snapshot().repos).toHaveLength(255);
    expect(restarted.manager.snapshot().repos.map((r) => r.id)).toContain(apiRepo(255).id);
  });

  it('ignores ETag pages written in another format', async () => {
    const mock = releaseFixture();
    const local = new FakeArea('local');
    local.applyRaw({ [ETAGS_KEY]: JSON.stringify({ 'https://api.github.com/user/repos?x': { etag: 'W/"1"', next: null, items: 'not-an-array' } }) });
    const h = await harness(mock, { local });
    await h.manager.refresh();
    expect(h.manager.snapshot().repos).toHaveLength(255);
  });

  it('shows the list but reports when browser storage is full', async () => {
    const mock = releaseFixture();
    const local = new FakeArea('local');
    const h = await harness(mock, { local });
    local.failNext = new Error('QUOTA_BYTES quota exceeded');
    await h.manager.refresh();
    expect(h.manager.snapshot().repos).toHaveLength(255);
    expect(h.manager.snapshot().status).toMatchObject({ kind: 'error', message: expect.stringMatching(/storage is full/) });
  });

  it('reports offline when the token cannot be renewed because GitHub is unreachable', async () => {
    const mock = releaseFixture();
    const h = await harness(mock);
    h.auth.reason = 'transient';
    await h.manager.refresh();
    expect(h.manager.snapshot().status.kind).toBe('offline');
  });
});
