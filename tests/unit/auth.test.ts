import { describe, expect, it } from 'vitest';
import { accountPrefix, ACCOUNTS_KEY, AuthManager, IDENTITY_KEY, PENDING_KEY, TOKENS_KEY, CLIENT_ID_KEY } from '../../src/background/auth/authManager';
import { DeviceFlowError, POLL_MARGIN_MS, pollDeviceToken, requestDeviceCode, tokenSetFrom, type PendingFlow } from '../../src/background/auth/deviceFlow';
import type { AuthState } from '../../src/shared/types';
import { FakeArea, ManualTimers } from '../helpers/fakeStorage';
import type { MockGitHub} from '../helpers/mockGithub';
import { releaseFixture } from '../helpers/mockGithub';

const bases = { apiBase: 'https://api.github.com', oauthBase: 'https://github.com' };
const CLIENT = 'Iv23liTestClient01';

function jsonFetch(status: number, body: unknown) {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

describe('device flow protocol', () => {
  it('requests a code with only the client ID and validates the response', async () => {
    const mock = releaseFixture();
    const flow = await requestDeviceCode(mock.fetch(bases), bases.oauthBase, CLIENT, 1000);
    expect(flow).toMatchObject({ userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', intervalS: 1, expiresAt: 1000 + 900_000 });
  });

  it('maps setup errors to non-restartable problems', async () => {
    await expect(requestDeviceCode(jsonFetch(404, { error: 'Not Found' }), bases.oauthBase, CLIENT, 0)).rejects.toMatchObject({ code: 'bad-client', restartable: false });
    await expect(requestDeviceCode(jsonFetch(400, { error: 'device_flow_disabled' }), bases.oauthBase, CLIENT, 0)).rejects.toMatchObject({ code: 'disabled', restartable: false });
    await expect(requestDeviceCode(() => Promise.reject(new TypeError('offline')), bases.oauthBase, CLIENT, 0)).rejects.toMatchObject({ code: 'network', restartable: true });
  });

  it('never sends the user anywhere but github.com to enter the code', async () => {
    const evil = jsonFetch(200, { device_code: 'd', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com.evil.example/login/device', expires_in: 900, interval: 5 });
    await expect(requestDeviceCode(evil, bases.oauthBase, CLIENT, 0)).rejects.toBeInstanceOf(DeviceFlowError);
  });

  const flow: PendingFlow = { clientId: CLIENT, deviceCode: 'dc', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', intervalS: 5, requestedAt: 0, expiresAt: 900_000, lastPollAt: 0 };

  it('keeps polling on authorization_pending and slows down permanently on slow_down', async () => {
    expect(await pollDeviceToken(jsonFetch(200, { error: 'authorization_pending' }), bases.oauthBase, flow, 1)).toEqual({ kind: 'pending', intervalS: 5 });
    expect(await pollDeviceToken(jsonFetch(200, { error: 'slow_down', interval: 10 }), bases.oauthBase, flow, 1)).toEqual({ kind: 'pending', intervalS: 10 });
    expect(await pollDeviceToken(jsonFetch(200, { error: 'slow_down' }), bases.oauthBase, { ...flow, intervalS: 10 }, 1)).toEqual({ kind: 'pending', intervalS: 15 });
  });

  it('ends on expiry, denial and bad codes with restartable errors', async () => {
    for (const [error, code] of [['expired_token', 'expired'], ['token_expired', 'expired'], ['access_denied', 'denied'], ['incorrect_device_code', 'bad-code']] as const) {
      await expect(pollDeviceToken(jsonFetch(200, { error }), bases.oauthBase, flow, 1)).rejects.toMatchObject({ code, restartable: true });
    }
    await expect(pollDeviceToken(jsonFetch(200, { error: 'authorization_pending' }), bases.oauthBase, flow, 900_000)).rejects.toMatchObject({ code: 'expired' });
  });

  it('builds token sets with and without expiry (app owners may opt out of expiring tokens)', () => {
    expect(tokenSetFrom({ access_token: 'ghu_a', expires_in: 28800, refresh_token: 'ghr_b', refresh_token_expires_in: 15897600 }, CLIENT, 10)).toEqual({
      clientId: CLIENT,
      accessToken: 'ghu_a',
      expiresAt: 10 + 28_800_000,
      refreshToken: 'ghr_b',
      refreshExpiresAt: 10 + 15_897_600_000,
      obtainedAt: 10,
    });
    expect(tokenSetFrom({ access_token: 'ghu_a', token_type: 'bearer', scope: '' }, CLIENT, 10)).toMatchObject({ expiresAt: null, refreshToken: null });
  });
});

interface Harness {
  mock: MockGitHub;
  timers: ManualTimers;
  local: FakeArea;
  session: FakeArea;
  sync: FakeArea;
  states: AuthState[];
  events: string[];
  manager: AuthManager;
  restart(): Promise<AuthManager>;
}

const ME = 1001;
const mine = (key: string) => accountPrefix(ME) + key;

async function harness(mock = releaseFixture(), timers = new ManualTimers(), local = new FakeArea('local'), session = new FakeArea('session'), sync = new FakeArea('sync')): Promise<Harness> {
  const states: AuthState[] = [];
  const events: string[] = [];
  const make = async () => {
    const manager: AuthManager = new AuthManager({
      local,
      sync,
      session,
      fetch: mock.fetch(bases),
      timers,
      config: { clientId: CLIENT, ...bases },
      carryOver: ['inventory.cache'],
      onChange: (userId) => states.push(manager.state(userId)),
      onSignedIn: (userId, added) => events.push(`signed-in:${userId}:${added}`),
      onSignedOut: (userId, reason) => events.push(`signed-out:${userId}:${reason}`),
    });
    await manager.init();
    return manager;
  };
  const manager = await make();
  return { mock, timers, local, session, sync, states, events, manager, restart: make };
}

/** Runs the device flow to the end for whichever account the mock answers /user with. */
async function connect(h: Harness, manager = h.manager): Promise<void> {
  h.mock.deviceSteps = ['success'];
  await manager.start();
  await h.timers.advance(5000);
}

function tokenRequestTimes(h: Harness, grant = 'urn:ietf:params:oauth:grant-type:device_code') {
  return h.mock.tokenRequests.filter((r) => r.grant_type === grant);
}

const oldTokens = { clientId: CLIENT, accessToken: 'ghu_mockUserToken0000000000000000000000', expiresAt: null, refreshToken: null, refreshExpiresAt: null, obtainedAt: 0 };

describe('AuthManager', () => {
  it('runs the device flow to a signed-in account without exposing the token', async () => {
    const h = await harness();
    h.mock.deviceSteps = ['pending', 'slow_down', 'pending', 'success'];
    const started = await h.manager.start();
    expect(started).toMatchObject({ kind: 'authorizing', userCode: 'WDJB-MJHT' });
    await h.timers.advance(60_000);
    expect(h.manager.state(ME)).toMatchObject({ kind: 'signed-in', login: 'jd2005l' });
    expect(h.manager.state()).toMatchObject({ kind: 'signed-out', problem: null }); // nothing being connected now
    expect(h.events).toEqual([`signed-in:${ME}:true`]);
    expect((h.local.raw()[mine(TOKENS_KEY)] as { accessToken: string }).accessToken).toBe(h.mock.token);
    expect(h.local.raw()[ACCOUNTS_KEY]).toEqual([ME]);
    expect(h.session.raw()[PENDING_KEY]).toBeUndefined();
    expect(JSON.stringify(h.states)).not.toMatch(/ghu_|ghr_|device_code|dc_/);
    expect(h.mock.tokenRequests.every((r) => !('client_secret' in r))).toBe(true);
  });

  it('respects the poll interval, including the slow_down increase', async () => {
    const h = await harness();
    h.mock.deviceSteps = ['pending', 'slow_down', 'pending', 'success'];
    const times: number[] = [];
    const inner = h.mock.fetch(bases);
    (h.manager as unknown as { deps: { fetch: typeof inner } }).deps.fetch = (url, init) => {
      if (url.includes('access_token')) times.push(h.timers.now());
      return inner(url, init);
    };
    const t0 = h.timers.now();
    await h.manager.start();
    await h.timers.advance(120_000);
    const gaps = times.map((t, i) => t - (i ? times[i - 1]! : t0));
    // interval 1 s (+margin) until slow_down raises it to 6 s (+margin).
    expect(gaps[0]).toBeGreaterThanOrEqual(1000 + POLL_MARGIN_MS);
    expect(gaps[1]).toBeGreaterThanOrEqual(1000 + POLL_MARGIN_MS);
    expect(gaps[2]).toBeGreaterThanOrEqual(6000 + POLL_MARGIN_MS);
    expect(gaps[3]).toBeGreaterThanOrEqual(6000 + POLL_MARGIN_MS);
  });

  it('resumes a sign-in after a worker restart without polling early', async () => {
    const h = await harness();
    h.mock.deviceSteps = ['pending', 'pending', 'success'];
    await h.manager.start();
    await h.timers.advance(2000 + POLL_MARGIN_MS); // first poll answered
    const before = tokenRequestTimes(h).length;
    expect(before).toBe(1);
    const lastPoll = h.timers.now();
    const restarted = await h.restart(); // old worker gone (its timers die with it)
    (h.manager as unknown as { pending: null }).pending = null;
    expect(restarted.state()).toMatchObject({ kind: 'authorizing' });
    await h.timers.advance(500);
    expect(tokenRequestTimes(h).length).toBe(before); // not before a full interval
    await h.timers.advance(30_000);
    expect(restarted.state(ME)).toMatchObject({ kind: 'signed-in' });
    expect(h.timers.now()).toBeGreaterThan(lastPoll);
  });

  it('reports a denied authorization and lets the user start again', async () => {
    const h = await harness();
    h.mock.deviceSteps = ['denied'];
    await h.manager.start();
    await h.timers.advance(10_000);
    expect(h.manager.state()).toMatchObject({ kind: 'signed-out', problem: { restartable: true } });
    await connect(h);
    expect(h.manager.state(ME).kind).toBe('signed-in');
  });

  it('cancels a pending sign-in', async () => {
    const h = await harness();
    h.mock.deviceSteps = ['pending', 'pending', 'pending', 'success'];
    await h.manager.start();
    await h.manager.cancel();
    await h.timers.advance(60_000);
    expect(h.manager.state().kind).toBe('signed-out');
    expect(h.manager.list()).toHaveLength(0);
    expect(tokenRequestTimes(h)).toHaveLength(0);
  });

  it('refreshes shortly before expiry without a client secret and persists the new pair first', async () => {
    const h = await harness();
    await connect(h);
    h.mock.refreshAccepted = true;
    await h.timers.advance(28_800_000 - 4 * 60_000); // inside the early-refresh window
    const token = await h.manager.account(ME)!.accessToken();
    expect(token).toMatch(/^ghu_refreshed/);
    expect((h.local.raw()[mine(TOKENS_KEY)] as { accessToken: string }).accessToken).toBe(token);
    const refresh = tokenRequestTimes(h, 'refresh_token');
    expect(refresh).toHaveLength(1);
    expect(refresh[0]).toEqual({ client_id: CLIENT, grant_type: 'refresh_token', refresh_token: 'ghr_mockRefresh' });
  });

  it('expires the authorization when GitHub rejects the refresh, keeping the account listed for "Reconnect"', async () => {
    const h = await harness();
    await connect(h);
    h.mock.refreshAccepted = false;
    const account = h.manager.account(ME)!;
    expect(await account.onUnauthorized()).toBe(false);
    expect(h.manager.state(ME)).toEqual({ kind: 'expired', login: 'jd2005l' });
    expect(h.manager.list()).toHaveLength(1);
    expect(h.local.raw()[mine(TOKENS_KEY)]).toBeUndefined();
    expect(h.events).toContain(`signed-out:${ME}:expired`);
    expect(await account.accessToken()).toBeNull();
    // Connecting again renews the same account.
    await connect(h);
    expect(h.manager.state(ME).kind).toBe('signed-in');
    expect(h.events.at(-1)).toBe(`signed-in:${ME}:false`);
  });

  it('retries a 401 with a refreshed token once, never in a loop', async () => {
    const h = await harness();
    await connect(h);
    h.mock.refreshAccepted = true;
    const account = h.manager.account(ME)!;
    expect(await account.onUnauthorized()).toBe(true);
    expect(await account.onUnauthorized()).toBe(false); // second 401 within a minute: give up
    expect(h.manager.state(ME).kind).toBe('expired');
    expect(tokenRequestTimes(h, 'refresh_token')).toHaveLength(1);
  });

  it('disconnects an account by forgetting its tokens and identity', async () => {
    const h = await harness();
    await connect(h);
    await h.manager.signOut(ME);
    expect(h.manager.list()).toHaveLength(0);
    expect(h.manager.state(ME)).toMatchObject({ kind: 'signed-out' });
    expect(h.local.raw()[mine(TOKENS_KEY)]).toBeUndefined();
    expect(h.local.raw()[mine(IDENTITY_KEY)]).toBeUndefined();
    expect(h.local.raw()[ACCOUNTS_KEY]).toEqual([]);
    expect(h.events).toContain(`signed-out:${ME}:signout`);
  });

  it('never brings a session back when sign-out happens during a token refresh', async () => {
    const h = await harness();
    await connect(h);
    h.mock.refreshAccepted = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = h.mock.fetch(bases);
    const account = h.manager.account(ME)!;
    (account as unknown as { deps: { fetch: typeof inner } }).deps.fetch = async (url, init) => {
      if (url.includes('access_token')) await gate;
      return inner(url, init);
    };
    await h.timers.advance(28_800_000 - 60_000); // inside the early-refresh window
    const pendingToken = account.token();
    await new Promise((r) => setTimeout(r, 5));
    await h.manager.signOut(ME);
    release();
    expect(await pendingToken).toEqual({ reason: 'expired' });
    expect(h.manager.state(ME).kind).toBe('signed-out');
    expect(h.local.raw()[mine(TOKENS_KEY)]).toBeUndefined();
  });

  it('keeps the session when a 401 refresh fails only transiently', async () => {
    const h = await harness();
    await connect(h);
    const inner = h.mock.fetch(bases);
    const account = h.manager.account(ME)!;
    (account as unknown as { deps: { fetch: typeof inner } }).deps.fetch = (url, init) =>
      url.includes('access_token') ? Promise.resolve(new Response('{}', { status: 502 })) : inner(url, init);
    expect(await account.onUnauthorized()).toBe(false);
    expect(h.manager.state(ME).kind).toBe('signed-in');
    expect(h.local.raw()[mine(TOKENS_KEY)]).toBeDefined();
  });

  it('expires a token that is past its expiry when it cannot be refreshed at all', async () => {
    const h = await harness();
    await h.local.set({
      [ACCOUNTS_KEY]: [ME],
      [mine(IDENTITY_KEY)]: { login: 'jd2005l', userId: ME },
      [mine(TOKENS_KEY)]: { ...oldTokens, accessToken: 'ghu_old', expiresAt: h.timers.now() - 1 },
    });
    const restarted = await h.restart();
    expect(await restarted.account(ME)!.token()).toEqual({ reason: 'expired' });
    expect(restarted.state(ME).kind).toBe('expired');
  });

  it('keeps polling through a network blip while the user is entering the code', async () => {
    const h = await harness();
    h.mock.deviceSteps = ['pending', 'success'];
    const inner = h.mock.fetch(bases);
    let blips = 0;
    (h.manager as unknown as { deps: { fetch: typeof inner } }).deps.fetch = (url, init) => {
      if (url.includes('access_token') && blips++ === 0) return Promise.reject(new TypeError('Failed to fetch'));
      return inner(url, init);
    };
    await h.manager.start();
    await h.timers.advance(120_000);
    expect(h.manager.state(ME).kind).toBe('signed-in');
  });

  it('connects a second GitHub account next to the first, each with its own tokens', async () => {
    const h = await harness();
    await connect(h);
    h.mock.login = 'jd-work';
    h.mock.userId = 2002;
    await connect(h);
    expect(h.manager.list().map((a) => [a.userId, a.login])).toEqual([
      [ME, 'jd2005l'],
      [2002, 'jd-work'],
    ]);
    expect(h.events).toEqual([`signed-in:${ME}:true`, 'signed-in:2002:true']);
    expect(h.manager.find('JD-Work')?.userId).toBe(2002); // logins are case-insensitive
    expect(h.local.raw()[ACCOUNTS_KEY]).toEqual([ME, 2002]);
    expect(h.local.raw()[accountPrefix(2002) + TOKENS_KEY]).toBeDefined();
    // Disconnecting one leaves the other connected.
    await h.manager.signOut(2002);
    expect(h.manager.state(ME).kind).toBe('signed-in');
    expect(h.manager.find('jd-work')).toBeNull();
    const restarted = await h.restart();
    expect(restarted.list().map((a) => a.login)).toEqual(['jd2005l']);
  });

  it('does not keep a token whose account GitHub will not name', async () => {
    const h = await harness();
    const inner = h.mock.fetch(bases);
    (h.manager as unknown as { deps: { fetch: typeof inner } }).deps.fetch = (url, init) =>
      url.endsWith('/user') ? Promise.resolve(new Response('{}', { status: 502 })) : inner(url, init);
    await connect(h);
    expect(h.manager.list()).toHaveLength(0);
    expect(h.manager.state()).toMatchObject({ kind: 'signed-out', problem: { restartable: true } });
    expect(Object.keys(h.local.raw()).some((k) => k.includes(TOKENS_KEY))).toBe(false);
  });

  it('moves the one account an earlier version kept (and its cache) under that account', async () => {
    const local = new FakeArea('local');
    await local.set({ [TOKENS_KEY]: oldTokens, [IDENTITY_KEY]: { login: 'jd2005l', userId: ME }, 'inventory.cache': { repos: [], fetchedAt: 5 } });
    const h = await harness(releaseFixture(), new ManualTimers(), local);
    expect(h.manager.migrated).toBe(ME);
    expect(h.manager.state(ME)).toMatchObject({ kind: 'signed-in', login: 'jd2005l' });
    expect(local.raw()).toMatchObject({ [ACCOUNTS_KEY]: [ME], [mine(TOKENS_KEY)]: oldTokens, [mine('inventory.cache')]: { repos: [], fetchedAt: 5 } });
    expect(local.raw()[TOKENS_KEY]).toBeUndefined();
    expect(local.raw()['inventory.cache']).toBeUndefined();
    // Only once.
    const restarted = await h.restart();
    expect(restarted.migrated).toBeNull();
    expect(restarted.list()).toHaveLength(1);
  });

  it('asks GitHub whose an old token is when an earlier version never learned it, and waits while it cannot ask', async () => {
    const local = new FakeArea('local');
    await local.set({ [TOKENS_KEY]: oldTokens, [IDENTITY_KEY]: { login: null, userId: null } });
    const inner = releaseFixture().fetch(bases);
    let offline = true;
    const make = async () => {
      const manager = new AuthManager({
        local,
        sync: new FakeArea('sync'),
        session: new FakeArea('session'),
        fetch: (url, init) => (offline ? Promise.reject(new TypeError('Failed to fetch')) : inner(url, init)),
        timers: new ManualTimers(),
        config: { clientId: CLIENT, ...bases },
        onChange: () => undefined,
        onSignedIn: () => undefined,
        onSignedOut: () => undefined,
      });
      await manager.init();
      return manager;
    };
    expect((await make()).list()).toHaveLength(0);
    expect(local.raw()[TOKENS_KEY]).toEqual(oldTokens); // kept for the next start
    offline = false;
    expect((await make()).state(ME)).toMatchObject({ kind: 'signed-in', login: 'jd2005l' });
  });

  it('accepts only GitHub App client IDs, never a 40-hex client secret', async () => {
    const h = await harness();
    await expect(h.manager.setClientId('0123456789abcdef0123456789abcdef01234567')).rejects.toThrow(/secret/);
    await h.manager.setClientId('Iv1.0123456789abcdef');
    await h.manager.setClientId('Iv23liAbCdEfGh123456');
  });

  it('asks for a client ID instead of starting when none is configured', async () => {
    const h = await harness();
    (h.manager as unknown as { deps: { config: { clientId: string } } }).deps.config.clientId = '';
    expect(await h.manager.start()).toMatchObject({ kind: 'signed-out', clientIdConfigured: false, problem: { restartable: false } });
    await h.manager.setClientId('Iv23liFromOptions01');
    expect(h.manager.clientId()).toEqual({ value: 'Iv23liFromOptions01', source: 'options' });
    await expect(h.manager.setClientId('not a client id!')).rejects.toThrow();
  });

  it('keeps the client ID in Chrome Sync (never tokens), so another browser only has to connect', async () => {
    const h = await harness();
    await h.manager.setClientId('Iv23liSharedClient01');
    expect(h.sync.raw()).toEqual({ [CLIENT_ID_KEY]: 'Iv23liSharedClient01' });
    expect(h.local.raw()[CLIENT_ID_KEY]).toBeUndefined();
    // A second browser on the same Chrome profile receives it.
    const other = await harness(releaseFixture(), new ManualTimers(), new FakeArea('local'), new FakeArea('session'), h.sync);
    expect(other.manager.clientId()).toEqual({ value: 'Iv23liSharedClient01', source: 'options' });
    // Signing in stays per device: nothing token-shaped is synced.
    await connect(h);
    expect(h.manager.account(ME)!.isSignedIn()).toBe(true);
    expect(Object.keys(h.sync.raw())).toEqual([CLIENT_ID_KEY]);
  });

  it('moves a client ID saved on this device by an earlier version into Chrome Sync', async () => {
    const local = new FakeArea('local');
    const sync = new FakeArea('sync');
    await local.set({ [CLIENT_ID_KEY]: 'Iv23liOldLocalOnly01' });
    const h = await harness(releaseFixture(), new ManualTimers(), local, new FakeArea('session'), sync);
    expect(h.manager.clientId().value).toBe('Iv23liOldLocalOnly01');
    expect(sync.raw()).toEqual({ [CLIENT_ID_KEY]: 'Iv23liOldLocalOnly01' });
    expect(local.raw()[CLIENT_ID_KEY]).toBeUndefined();
  });

  it('picks up a client ID that arrives through Chrome Sync while open', async () => {
    const h = await harness();
    (h.manager as unknown as { deps: { config: { clientId: string } } }).deps.config.clientId = '';
    expect(h.manager.state()).toMatchObject({ kind: 'signed-out', clientIdConfigured: false });
    h.manager.syncedClientId('Iv23liArrivedLater01');
    expect(h.states.at(-1)).toMatchObject({ kind: 'signed-out', clientIdConfigured: true });
    h.manager.syncedClientId(undefined); // cleared on another browser
    expect(h.states.at(-1)).toMatchObject({ kind: 'signed-out', clientIdConfigured: false });
  });
});
