import { CONFIG } from '../shared/config';
import { assignedIds, emptyLayout, isValidLayoutOp, unavailableCount, type LayoutOp } from '../shared/layout/model';
import { needsStartChoice, OPTIONS_TABS, PRIVILEGED_TYPES, type Broadcast, type Diagnostics, type NavState, type Onboarding, type Request, type Response } from '../shared/messages';
import { UNCATEGORIZED_ID as UNCATEGORIZED } from '../shared/layout/model';
import type { InventorySnapshot, LayoutSnapshot } from '../shared/types';
import { accountPrefix, AuthManager, CLIENT_ID_KEY, type AccountAuth } from './auth/authManager';
import { CACHE_KEY, ETAGS_KEY, InventoryManager, RATE_LIMIT_KEY } from './inventoryManager';
import { LayoutStore, MIRROR_KEY, type StorageAreaLike, type Timers } from './layoutStore';
import { keysUnder, namespaced, ownKeys } from './namespacedArea';

const REFRESH_ALARM = 'grn-refresh';
const AUTH_ALARM = 'grn-auth-watchdog';
/** Wakes the worker for a delayed sync write (a setTimeout would die with the idle worker). */
const LAYOUT_WAKE_ALARM = 'grn-layout-wake';
const MAX_OPS_PER_REQUEST = 500;
/** storage.sync, under the account's layout prefix: that account's first-run answer. */
const ONBOARDING_KEY = 'onboarding';
/**
 * storage.sync: the GitHub user ID whose layout is the unprefixed "grn:" document, the one versions before 1.3
 * wrote for their single account. The first account seen after updating claims it; every other account's layout
 * lives under its own prefix.
 */
const LAYOUT_OWNER_KEY = 'layout.owner';
const layoutPrefix = (userId: number): string => (userId === layoutOwner ? '' : `grn@${userId}/`);

const timers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const boundFetch = (input: string, init?: RequestInit) => fetch(input, init);
const local = chrome.storage.local as unknown as StorageAreaLike;
const sync = chrome.storage.sync as unknown as StorageAreaLike;
const session = chrome.storage.session as unknown as StorageAreaLike;

function broadcast(message: Broadcast): void {
  // Extension pages (Options) listen on runtime messages; github.com tabs on tab messages.
  chrome.runtime.sendMessage(message).catch(() => undefined);
  chrome.tabs
    .query({ url: ['https://github.com/*'] })
    .then((tabs) => {
      for (const tab of tabs) if (tab.id !== undefined) chrome.tabs.sendMessage(tab.id, message).catch(() => undefined);
    })
    .catch(() => undefined);
}

/** Everything kept for one GitHub account: its authorization, its repository cache and its synced layout. */
interface Account {
  userId: number;
  auth: AccountAuth;
  inventory: InventoryManager;
  layout: LayoutStore;
  /** Prefix of its layout and first-run answer in storage.sync ('' for the layout owner). */
  syncPrefix: string;
  onboarding: Onboarding;
  lastIds: string;
}

const accounts = new Map<number, Promise<Account>>();
let layoutOwner: number | null = null;

const auth = new AuthManager({
  local,
  sync,
  session,
  fetch: boundFetch,
  timers,
  config: { clientId: CONFIG.clientId, oauthBase: CONFIG.oauthBase, apiBase: CONFIG.apiBase },
  carryOver: [CACHE_KEY, ETAGS_KEY, RATE_LIMIT_KEY, MIRROR_KEY],
  onChange: (userId) => {
    broadcast({ type: 'nav/auth', account: userId, auth: auth.state(userId) });
    if (userId === null && auth.state().kind !== 'authorizing') void chrome.alarms.clear(AUTH_ALARM);
  },
  onSignedIn: (userId, added) => {
    void (async () => {
      const account = await open(userId);
      if (added) broadcast({ type: 'nav/accounts' });
      await account.inventory.refresh({ force: true });
    })();
  },
  onSignedOut: (userId, reason) => {
    // Expired: keep showing the cached list with a reconnect banner. Disconnected: forget it on this device.
    if (reason === 'signout') void close(userId);
  },
});

/** Opens (once) the stores of a connected account. */
function open(userId: number): Promise<Account> {
  const existing = accounts.get(userId);
  if (existing) return existing;
  const opening = create(userId);
  accounts.set(userId, opening);
  return opening;
}

async function create(userId: number): Promise<Account> {
  if (layoutOwner === null) {
    layoutOwner = userId;
    await chrome.storage.sync.set({ [LAYOUT_OWNER_KEY]: userId });
  }
  const accountAuth = auth.account(userId);
  if (!accountAuth) throw new Error('That account is not connected.');
  const prefix = layoutPrefix(userId);
  const accountLocal = namespaced(local, accountPrefix(userId));
  const accountSync = namespaced(sync, prefix);
  const account = { userId, auth: accountAuth, syncPrefix: prefix, onboarding: { startChosen: false }, lastIds: '' } as Account;
  account.inventory = new InventoryManager({
    local: accountLocal,
    fetch: boundFetch,
    timers,
    apiBase: CONFIG.apiBase,
    auth: accountAuth,
    onChange: (snapshot) => {
      broadcast({ type: 'nav/inventory', account: userId, inventory: snapshot });
      const ids = snapshot.repos.length + ':' + (snapshot.fetchedAt ?? 0);
      if (ids !== account.lastIds) {
        account.lastIds = ids;
        account.layout.inventoryChanged();
      }
    },
  });
  account.layout = new LayoutStore({
    sync: accountSync,
    local: accountLocal,
    timers,
    inventory: () => account.inventory.ids(),
    emit: (snapshot) => {
      broadcast({ type: 'nav/layout', account: userId, layout: snapshot });
      // Sections exist (made here, applied from a suggestion, imported or synced in): the first-run question is moot,
      // and stays answered even if every section is deleted later.
      if (snapshot.layout.sections.some((s) => s.id !== UNCATEGORIZED)) void answerStartChoice(account);
    },
    wake: (ms) => void chrome.alarms.create(LAYOUT_WAKE_ALARM, { when: Date.now() + ms + 1000 }),
  });
  await account.inventory.init();
  const synced = await accountSync.get(ONBOARDING_KEY);
  let stored = synced[ONBOARDING_KEY] as Partial<Onboarding> | undefined;
  if (prefix === '') {
    // 1.1 kept the answer on this device only.
    const legacy = await chrome.storage.local.get(ONBOARDING_KEY);
    if (legacy[ONBOARDING_KEY] !== undefined) {
      stored ??= legacy[ONBOARDING_KEY] as Partial<Onboarding>;
      if (stored?.startChosen === true && synced[ONBOARDING_KEY] === undefined) await accountSync.set({ [ONBOARDING_KEY]: { startChosen: true } });
      await chrome.storage.local.remove(ONBOARDING_KEY);
    }
  }
  account.onboarding = { startChosen: stored?.startChosen === true };
  await account.layout.init();
  return account;
}

/** A disconnected account: its pending layout edits go to Chrome Sync, everything else it kept here is removed. */
async function close(userId: number): Promise<void> {
  const opening = accounts.get(userId);
  accounts.delete(userId);
  broadcast({ type: 'nav/accounts' });
  if (opening) {
    const account = await opening.catch(() => null);
    await account?.layout.flush().catch(() => undefined);
    await account?.inventory.clear();
  }
  await local.remove(await keysUnder(local, accountPrefix(userId)));
}

async function answerStartChoice(account: Account): Promise<void> {
  if (account.onboarding.startChosen) return;
  account.onboarding = { startChosen: true };
  // Synced with the account's layout: answered once for every browser of this Chrome profile.
  await namespaced(sync, account.syncPrefix).set({ [ONBOARDING_KEY]: account.onboarding });
  broadcast({ type: 'nav/onboarding', account: account.userId, onboarding: account.onboarding });
}

/** The start choice arrived from another browser through Chrome Sync. */
function syncedOnboarding(account: Account, value: unknown): void {
  if (account.onboarding.startChosen || !(value && typeof value === 'object' && (value as Partial<Onboarding>).startChosen === true)) return;
  account.onboarding = { startChosen: true };
  broadcast({ type: 'nav/onboarding', account: account.userId, onboarding: account.onboarding });
}

async function init(): Promise<void> {
  // Keep tokens and the cache away from content scripts: they get data from this worker by message only.
  try {
    await (chrome.storage.local as unknown as { setAccessLevel?: (o: { accessLevel: string }) => Promise<void> }).setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    // Older Chrome without setAccessLevel on local storage: content scripts still never ask for these keys.
  }
  const owner = (await chrome.storage.sync.get(LAYOUT_OWNER_KEY))[LAYOUT_OWNER_KEY];
  layoutOwner = typeof owner === 'number' ? owner : null;
  await auth.init();
  if (auth.migrated !== null) {
    // The account 1.2 had connected here owns the layout it wrote, unless another browser already gave it to a
    // different account; then this device's copy of that layout's edits belongs to that one, not this account.
    if (layoutOwner === null) {
      layoutOwner = auth.migrated;
      await chrome.storage.sync.set({ [LAYOUT_OWNER_KEY]: layoutOwner });
    } else if (layoutOwner !== auth.migrated) {
      await local.remove(accountPrefix(auth.migrated) + MIRROR_KEY);
    }
  }
  await Promise.all(auth.list().map((a) => open(a.userId)));
  // A sign-in watchdog left over from an abandoned flow (pending state is gone after a restart) only wastes wakeups.
  if (auth.state().kind !== 'authorizing') await chrome.alarms.clear(AUTH_ALARM);
  const existing = await chrome.alarms.get(REFRESH_ALARM);
  if (!existing) await chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: 30, delayInMinutes: 1 });
}

const ready = init();

/**
 * The account a request is about: the one with the login it names (none, when that account is not connected
 * here), or without a login the first one that is signed in (else the first listed).
 */
async function accountFor(login: string | undefined): Promise<Account | null> {
  const listed = auth.list();
  const match = login ? auth.find(login) : (listed.find((a) => a.isSignedIn()) ?? listed[0] ?? null);
  return match ? open(match.userId) : null;
}

const EMPTY_INVENTORY: InventorySnapshot = { repos: [], fetchedAt: null, installations: [], status: { kind: 'idle' } };
const EMPTY_LAYOUT: LayoutSnapshot = {
  layout: emptyLayout(),
  version: { epoch: 'none', seq: 0 },
  sync: { kind: 'ok', bytes: 0, chunks: 0, lastWriteAt: null, pending: false },
  editable: false,
};

function logins(): string[] {
  return auth.list().flatMap((a) => (a.login ? [a.login] : []));
}

function navState(account: Account | null, pageLogin: string | null = null): NavState {
  if (!account) return { account: null, accounts: logins(), pageLogin, auth: auth.state(), inventory: EMPTY_INVENTORY, layout: EMPTY_LAYOUT, onboarding: { startChosen: true } };
  return {
    account: { userId: account.userId, login: account.auth.login },
    accounts: logins(),
    pageLogin,
    auth: auth.state(account.userId),
    inventory: account.inventory.snapshot(),
    layout: account.layout.snapshot(),
    onboarding: account.onboarding,
  };
}

function isValidOps(ops: unknown): ops is LayoutOp[] {
  return Array.isArray(ops) && ops.length > 0 && ops.length <= MAX_OPS_PER_REQUEST && ops.every(isValidLayoutOp);
}

async function diagnostics(account: Account | null): Promise<Diagnostics> {
  const details = account?.inventory.details() ?? null;
  const snapshot = account?.layout.snapshot() ?? EMPTY_LAYOUT;
  const ids = account?.inventory.ids() ?? new Set<number>();
  let syncBytesInUse: number | null;
  try {
    syncBytesInUse = await chrome.storage.sync.getBytesInUse(null);
  } catch {
    syncBytesInUse = null;
  }
  return {
    extensionVersion: chrome.runtime.getManifest().version,
    clientId: auth.clientId(),
    appSlug: CONFIG.appSlug,
    accounts: auth.list().map((a) => ({ userId: a.userId, login: a.login, kind: a.state().kind })),
    account: account?.userId ?? null,
    auth: auth.state(account?.userId ?? null),
    connect: auth.state(),
    inventory: {
      count: details?.repos.length ?? 0,
      fetchedAt: details?.fetchedAt ?? null,
      pages: details?.pages ?? 0,
      notModifiedPages: details?.notModifiedPages ?? 0,
      rejected: details?.rejected ?? 0,
      installations: details?.installations ?? [],
      installationIssues: details?.installationIssues ?? [],
      ssoHiddenOrganizations: details?.ssoHiddenOrganizations ?? [],
      rateLimit: account?.inventory.rateLimit ?? { limit: null, remaining: null, resetAt: null },
      status: account?.inventory.snapshot().status ?? { kind: 'idle' },
    },
    layout: {
      sections: snapshot.layout.sections.length,
      assigned: assignedIds(snapshot.layout).size,
      unavailable: ids.size ? unavailableCount(snapshot.layout, ids) : 0,
      sync: snapshot.sync,
      editable: snapshot.editable,
      syncBytesInUse,
    },
    startChoice: needsStartChoice(navState(account)),
  };
}

const NOT_CONNECTED = 'Connect this GitHub account first.';

async function handle(request: Request, sender: chrome.runtime.MessageSender): Promise<Response> {
  await ready;
  const fromExtensionPage = typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
  if (PRIVILEGED_TYPES.has(request.type) && !fromExtensionPage) return { ok: false, error: 'Not allowed from this context.' };
  const login = typeof request.account === 'string' && request.account ? request.account : undefined;
  const account = await accountFor(login);

  switch (request.type) {
    case 'nav/get':
      if (account?.auth.isSignedIn() && account.inventory.isStale()) void account.inventory.refresh();
      return { ok: true, data: navState(account, login ?? null) };
    case 'layout/apply': {
      if (!account) return { ok: false, error: NOT_CONNECTED };
      if (!isValidOps(request.ops)) return { ok: false, error: 'Invalid layout change.' };
      const result = await account.layout.apply(request.ops);
      return result.ok ? { ok: true, data: result.snapshot } : { ok: false, error: result.error };
    }
    case 'inventory/refresh':
      if (account) void account.inventory.refresh({ force: request.force === true });
      return { ok: true, data: null };
    case 'suggest/hints':
      if (!account) return { ok: false, error: NOT_CONNECTED };
      try {
        return { ok: true, data: await account.inventory.hints() };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Reading repository details failed.' };
      }
    case 'options/open': {
      const tab = OPTIONS_TABS.find((t) => t === request.tab);
      // Options shows the account the request came from (the page's), so a tab or the account needs a URL.
      const query = request.account ? `?account=${encodeURIComponent(request.account)}` : '';
      if (tab || query) await chrome.tabs.create({ url: chrome.runtime.getURL(`options.html${query}${tab ? `#${request.suggest === true && tab === 'organize' ? 'organize-suggest' : tab}` : ''}`) });
      else await chrome.runtime.openOptionsPage();
      return { ok: true, data: null };
    }
    case 'onboarding/start-empty':
      if (account) await answerStartChoice(account);
      return { ok: true, data: null };
    case 'auth/start': {
      await chrome.alarms.create(AUTH_ALARM, { periodInMinutes: 0.5 });
      return { ok: true, data: await auth.start() };
    }
    case 'auth/cancel':
      await auth.cancel();
      return { ok: true, data: auth.state() };
    case 'auth/signout':
      if (account) await auth.signOut(account.userId);
      return { ok: true, data: auth.state() };
    case 'config/set-client-id':
      try {
        await auth.setClientId(typeof request.clientId === 'string' ? request.clientId : '');
        return { ok: true, data: auth.state() };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Invalid client ID.' };
      }
    case 'diagnostics/get':
      return { ok: true, data: await diagnostics(account) };
    case 'layout/reset':
      if (!account) return { ok: false, error: NOT_CONNECTED };
      return { ok: true, data: await account.layout.reset() };
    case 'layout/remove-unavailable': {
      if (!account) return { ok: false, error: NOT_CONNECTED };
      if (!account.inventory.ids().size) return { ok: false, error: 'Refresh your repositories first so nothing available is removed.' };
      const result = await account.layout.apply([{ type: 'removeUnavailable' }]);
      return result.ok ? { ok: true, data: result.snapshot } : { ok: false, error: result.error };
    }
    case 'data/clear-cache':
      if (!account) return { ok: false, error: NOT_CONNECTED };
      await account.inventory.clear();
      void account.inventory.refresh({ force: true });
      return { ok: true, data: null };
    default:
      return { ok: false, error: 'Unknown request.' };
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || typeof (message as { type?: unknown }).type !== 'string') return false;
  if ((message as { type: string }).type.startsWith('nav/') && (message as { type: string }).type !== 'nav/get') return false; // broadcasts
  handle(message as Request, sender)
    .then(sendResponse)
    .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Unexpected error.' } satisfies Response));
  return true;
});

/** Every connected account's stores, once open. */
async function each(fn: (account: Account) => void | Promise<void>): Promise<void> {
  await Promise.all([...accounts.values()].map((opening) => opening.then(fn, () => undefined)));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  void ready.then(() => {
    if (CLIENT_ID_KEY in changes) auth.syncedClientId(changes[CLIENT_ID_KEY].newValue);
    const changed = Object.keys(changes);
    void each((account) => {
      const keys = ownKeys(account.syncPrefix, changed);
      if (keys.includes(ONBOARDING_KEY)) syncedOnboarding(account, changes[account.syncPrefix + ONBOARDING_KEY]?.newValue);
      account.layout.onSyncChanged(keys);
    });
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  void ready.then(() => {
    if (alarm.name === REFRESH_ALARM) void each((account) => account.inventory.refresh());
    if (alarm.name === AUTH_ALARM) auth.ensurePolling(); // waking the worker re-arms a sign-in poll lost to a restart
    if (alarm.name === LAYOUT_WAKE_ALARM) void each((account) => account.layout.flush());
  });
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});
