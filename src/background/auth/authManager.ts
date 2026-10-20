import type { AuthProblem, AuthState } from '../../shared/types';
import type { FetchLike } from '../github/client';
import { GitHubClient, GitHubError } from '../github/client';
import type { StorageAreaLike, Timers } from '../layoutStore';
import { namespaced } from '../namespacedArea';
import { DeviceFlowError, POLL_MARGIN_MS, pollDeviceToken, refreshUserToken, requestDeviceCode, type PendingFlow, type TokenSet } from './deviceFlow';

/** storage.local (trusted contexts only), under the account's prefix: its token pair. Never synced, never logged. */
export const TOKENS_KEY = 'auth.tokens';
/** storage.local, under the account's prefix: who it is, kept after expiry so the UI can say "Reconnect @login". */
export const IDENTITY_KEY = 'auth.identity';
/** storage.local: the GitHub user IDs connected on this device, in the order they were connected. */
export const ACCOUNTS_KEY = 'auth.accounts';
/** Prefix of one account's keys in storage.local (its tokens, identity, repository cache and layout mirror). */
export const accountPrefix = (userId: number): string => `acct.${userId}.`;
/**
 * storage.sync: client ID entered in Options (overrides the build-time value). Synced, so another Chrome signed in
 * to the same profile only has to connect. It is a public identifier, not a secret. Not under the layout's "grn:"
 * prefix, which the layout store owns. Versions before 1.2 kept it in storage.local; init() moves it.
 */
export const CLIENT_ID_KEY = 'config.clientId';
/** storage.session (memory only): the device flow in progress. */
export const PENDING_KEY = 'auth.pending';

/** Refresh this long before the access token expires. */
export const REFRESH_EARLY_MS = 5 * 60_000;

export interface Identity {
  login: string | null;
  userId: number | null;
}

export interface AuthDeps {
  local: StorageAreaLike;
  /** chrome.storage.sync: only the client ID, never tokens. */
  sync: StorageAreaLike;
  session: StorageAreaLike;
  fetch: FetchLike;
  timers: Timers;
  config: { clientId: string; oauthBase: string; apiBase: string };
  /**
   * storage.local keys that versions before 1.3 kept for their one account (besides its tokens and identity). On
   * the first start of 1.3 they move under that account's prefix with its tokens.
   */
  carryOver?: readonly string[];
  /** An account's state changed (`userId`), or the connection in progress or the account list did (`null`). */
  onChange(userId: number | null): void;
  /** A new authorization is ready for `userId`. `added` is true when the account was not connected on this device. */
  onSignedIn(userId: number, added: boolean): void;
  /** An account's tokens are gone: disconnected (it is no longer listed) or expired (it is, to reconnect). */
  onSignedOut(userId: number, reason: 'signout' | 'expired'): void;
}

/** GitHub App client IDs start with "Iv" (Iv1.xxxxxxxxxxxxxxxx or Iv23…). A 40-hex client secret never matches. */
export const CLIENT_ID_RE = /^Iv[A-Za-z0-9.]{6,62}$/;

type RefreshOutcome = 'ok' | 'rejected' | 'transient';

function parseTokens(value: unknown): TokenSet | null {
  if (!value || typeof value !== 'object') return null;
  const t = value as Partial<TokenSet>;
  if (typeof t.accessToken !== 'string' || !t.accessToken || typeof t.clientId !== 'string') return null;
  return {
    clientId: t.clientId,
    accessToken: t.accessToken,
    expiresAt: typeof t.expiresAt === 'number' ? t.expiresAt : null,
    refreshToken: typeof t.refreshToken === 'string' && t.refreshToken ? t.refreshToken : null,
    refreshExpiresAt: typeof t.refreshExpiresAt === 'number' ? t.refreshExpiresAt : null,
    obtainedAt: typeof t.obtainedAt === 'number' ? t.obtainedAt : 0,
  };
}

function parseIdentity(value: unknown): Identity {
  const identity = value as Partial<Identity> | undefined;
  return { login: typeof identity?.login === 'string' ? identity.login : null, userId: typeof identity?.userId === 'number' ? identity.userId : null };
}

function parsePending(value: unknown): PendingFlow | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Partial<PendingFlow>;
  if (typeof p.deviceCode !== 'string' || typeof p.userCode !== 'string' || typeof p.verificationUri !== 'string') return null;
  if (typeof p.expiresAt !== 'number' || typeof p.intervalS !== 'number' || typeof p.clientId !== 'string' || typeof p.requestedAt !== 'number') return null;
  return { ...(p as PendingFlow), lastPollAt: typeof p.lastPollAt === 'number' ? p.lastPollAt : p.requestedAt };
}

/** Asks GitHub who a token belongs to. `rejected`: GitHub refused the token; `transient`: it could not be asked. */
async function whoIs(deps: Pick<AuthDeps, 'fetch' | 'config'>, accessToken: string): Promise<Identity | 'rejected' | 'transient'> {
  try {
    const client = new GitHubClient({ apiBase: deps.config.apiBase, token: accessToken, fetch: deps.fetch, etags: new Map() });
    const user = (await client.getJson(client.url('/user'))) as { login?: unknown; id?: unknown };
    if (typeof user.id !== 'number') return 'transient';
    return { login: typeof user.login === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(user.login) ? user.login : null, userId: user.id };
  } catch (error) {
    return error instanceof GitHubError && error.kind === 'unauthorized' ? 'rejected' : 'transient';
  }
}

interface AccountDeps {
  /** storage.local seen through this account's prefix. */
  local: StorageAreaLike;
  fetch: FetchLike;
  timers: Timers;
  oauthBase: string;
  onChange(): void;
  onExpired(): void;
}

/**
 * One GitHub account's authorization on this device. The token never leaves the service worker: callers get
 * `AuthState` (no secrets) or, inside the worker, a token through `token()`.
 */
export class AccountAuth {
  private tokens: TokenSet | null = null;
  private identity: Identity;
  private refreshing: Promise<RefreshOutcome> | null = null;
  private lastRefreshAt = -Infinity;
  /** Bumped by sign-in, sign-out and expiry; async work started under an older epoch must not write. */
  private epoch = 0;

  constructor(
    readonly userId: number,
    private readonly deps: AccountDeps,
  ) {
    this.identity = { login: null, userId };
  }

  async init(): Promise<void> {
    const items = await this.deps.local.get([TOKENS_KEY, IDENTITY_KEY]);
    this.tokens = parseTokens(items[TOKENS_KEY]);
    this.identity = { ...parseIdentity(items[IDENTITY_KEY]), userId: this.userId };
  }

  get login(): string | null {
    return this.identity.login;
  }

  /** Listed accounts are connected (signed in) or were and have expired (reconnect). */
  state(): Extract<AuthState, { kind: 'signed-in' | 'expired' }> {
    if (this.tokens) return { kind: 'signed-in', login: this.identity.login, expiresAt: this.tokens.expiresAt };
    return { kind: 'expired', login: this.identity.login };
  }

  isSignedIn(): boolean {
    return this.tokens !== null;
  }

  /** A new token pair for this account (connected again, or for the first time). */
  async adopt(token: TokenSet, identity: Identity): Promise<void> {
    this.epoch++;
    this.tokens = token;
    this.identity = { login: identity.login ?? this.identity.login, userId: this.userId };
    await this.deps.local.set({ [TOKENS_KEY]: token, [IDENTITY_KEY]: this.identity });
    this.deps.onChange();
  }

  /**
   * A usable access token, refreshed shortly before it expires, or why there is none:
   * `expired` (re-authorization needed), `transient` (GitHub unreachable; try again later) or `signed-out`.
   */
  async token(): Promise<{ token: string } | { reason: 'signed-out' | 'expired' | 'transient' }> {
    const tokens = this.tokens;
    if (!tokens) return { reason: 'expired' };
    const now = this.deps.timers.now();
    if (tokens.expiresAt !== null && now >= tokens.expiresAt - REFRESH_EARLY_MS) {
      if (!tokens.refreshToken) {
        if (now < tokens.expiresAt) return { token: tokens.accessToken };
        await this.expire();
        return { reason: 'expired' };
      }
      const outcome = await this.refresh();
      if (outcome === 'ok' && this.tokens) return { token: this.tokens.accessToken };
      if (outcome === 'rejected' || !this.tokens) return { reason: 'expired' };
      // Transient failure: the current token may still be good for a few minutes.
      return now < tokens.expiresAt ? { token: tokens.accessToken } : { reason: 'transient' };
    }
    return { token: tokens.accessToken };
  }

  async accessToken(): Promise<string | null> {
    const result = await this.token();
    return 'token' in result ? result.token : null;
  }

  /**
   * Called when GitHub answered 401 for the current token. Refreshes at most once per minute; returns true when
   * a new token is available for one retry. Never loops: repeated bad credentials make GitHub lock the user out.
   * A refresh that fails only transiently keeps the (still valid) refresh token.
   */
  async onUnauthorized(): Promise<boolean> {
    if (!this.tokens) return false;
    if (this.tokens.refreshToken && this.deps.timers.now() - this.lastRefreshAt > 60_000) {
      const outcome = await this.refresh();
      if (outcome === 'ok') return true;
      if (outcome === 'transient' || !this.tokens) return false;
    }
    await this.expire();
    return false;
  }

  private refresh(): Promise<RefreshOutcome> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<RefreshOutcome> {
    const tokens = this.tokens;
    if (!tokens?.refreshToken) return 'rejected';
    const epoch = this.epoch;
    const now = this.deps.timers.now();
    this.lastRefreshAt = now;
    if (tokens.refreshExpiresAt !== null && now >= tokens.refreshExpiresAt) {
      await this.expire();
      return 'rejected';
    }
    const result = await refreshUserToken(this.deps.fetch, this.deps.oauthBase, tokens.clientId, tokens.refreshToken, now);
    // Signed out, expired or re-authorized while GitHub was answering: never resurrect the old session.
    if (epoch !== this.epoch || this.tokens !== tokens) return 'rejected';
    if (result.kind === 'token') {
      // The old pair is already dead: persist the new one before anything uses it.
      this.tokens = result.token;
      await this.deps.local.set({ [TOKENS_KEY]: result.token });
      this.deps.onChange();
      return 'ok';
    }
    if (result.kind === 'rejected') {
      await this.expire();
      return 'rejected';
    }
    return 'transient';
  }

  private async expire(): Promise<void> {
    this.epoch++;
    this.tokens = null;
    await this.deps.local.remove(TOKENS_KEY);
    this.deps.onChange();
    this.deps.onExpired();
  }

  /** Forgets this account's authorization on this device. */
  async signOut(): Promise<void> {
    this.epoch++;
    this.tokens = null;
    await this.deps.local.remove([TOKENS_KEY, IDENTITY_KEY]);
  }
}

/**
 * Owns this device's GitHub authorizations: one per GitHub account connected here, and the one device flow
 * that connects the next. Whoever enters the code on github.com decides which account it connects: a new
 * account is added, a connected one gets fresh tokens.
 */
export class AuthManager {
  private readonly accounts = new Map<number, AccountAuth>();
  private pending: PendingFlow | null = null;
  private problem: AuthProblem | null = null;
  private clientIdOverride = '';
  private pollTimer: unknown = null;
  private polling = false;
  /** The account that 1.2 or earlier had connected, when this start moved it under its prefix. */
  migrated: number | null = null;

  constructor(private readonly deps: AuthDeps) {}

  async init(): Promise<void> {
    const [session, synced] = await Promise.all([this.deps.session.get(PENDING_KEY), this.deps.sync.get(CLIENT_ID_KEY)]);
    const local = await this.deps.local.get([ACCOUNTS_KEY, CLIENT_ID_KEY]);
    const valid = (value: unknown): string => (typeof value === 'string' && CLIENT_ID_RE.test(value) ? value : '');
    this.clientIdOverride = valid(synced[CLIENT_ID_KEY]) || valid(local[CLIENT_ID_KEY]);
    if (local[CLIENT_ID_KEY] !== undefined) {
      // Saved by an earlier version on this device only: share it with this Chrome profile's other browsers.
      if (this.clientIdOverride && !valid(synced[CLIENT_ID_KEY])) await this.deps.sync.set({ [CLIENT_ID_KEY]: this.clientIdOverride });
      await this.deps.local.remove(CLIENT_ID_KEY);
    }
    const ids = Array.isArray(local[ACCOUNTS_KEY]) ? (local[ACCOUNTS_KEY] as unknown[]).filter((x): x is number => typeof x === 'number' && Number.isSafeInteger(x)) : [];
    const migrated = await this.migrate();
    if (migrated !== null && !ids.includes(migrated)) ids.push(migrated);
    for (const id of new Set(ids)) {
      const account = this.makeAccount(id);
      await account.init();
      this.accounts.set(id, account);
    }
    if (migrated !== null) await this.saveAccounts();
    this.pending = parsePending(session[PENDING_KEY]);
    this.ensurePolling(); // the worker restarted mid sign-in
  }

  /**
   * Versions before 1.3 kept one account's tokens, identity, repository cache and layout mirror at fixed keys.
   * They move under that account's prefix. A token whose account was never identified is asked about once;
   * if GitHub cannot be reached, the move waits for the next start.
   */
  private async migrate(): Promise<number | null> {
    const moving = [TOKENS_KEY, IDENTITY_KEY, ...(this.deps.carryOver ?? [])];
    const legacy = await this.deps.local.get(moving);
    if (legacy[TOKENS_KEY] === undefined && legacy[IDENTITY_KEY] === undefined) return null;
    let identity = parseIdentity(legacy[IDENTITY_KEY]);
    const tokens = parseTokens(legacy[TOKENS_KEY]);
    if (identity.userId === null && tokens) {
      const who = await whoIs(this.deps, tokens.accessToken);
      if (who === 'transient') return null;
      if (who !== 'rejected') identity = who;
    }
    if (identity.userId === null) {
      await this.deps.local.remove(moving);
      return null;
    }
    const userId = identity.userId;
    const moved: Record<string, unknown> = { ...legacy, [IDENTITY_KEY]: identity };
    await this.deps.local.set(Object.fromEntries(Object.entries(moved).map(([key, value]) => [accountPrefix(userId) + key, value])));
    await this.deps.local.remove(moving);
    this.migrated = userId;
    return userId;
  }

  private makeAccount(userId: number): AccountAuth {
    const account: AccountAuth = new AccountAuth(userId, {
      local: namespaced(this.deps.local, accountPrefix(userId)),
      fetch: this.deps.fetch,
      timers: this.deps.timers,
      oauthBase: this.deps.config.oauthBase,
      onChange: () => this.deps.onChange(userId),
      onExpired: () => this.deps.onSignedOut(userId, 'expired'),
    });
    return account;
  }

  private async saveAccounts(): Promise<void> {
    await this.deps.local.set({ [ACCOUNTS_KEY]: [...this.accounts.keys()] });
  }

  /** Connected (or expired) accounts, in the order they were connected. */
  list(): AccountAuth[] {
    return [...this.accounts.values()];
  }

  account(userId: number): AccountAuth | null {
    return this.accounts.get(userId) ?? null;
  }

  /** The account with this GitHub login (case-insensitive, as GitHub treats logins). */
  find(login: string): AccountAuth | null {
    const wanted = login.toLowerCase();
    return this.list().find((a) => a.login?.toLowerCase() === wanted) ?? null;
  }

  /** Delay before the next poll may be sent: a full interval after GitHub's last answer. */
  private nextPollDelay(flow: PendingFlow): number {
    return Math.max(0, flow.lastPollAt + flow.intervalS * 1000 + POLL_MARGIN_MS - this.deps.timers.now());
  }

  /** Re-arms polling after a worker restart (alarm watchdog). Never polls early. */
  ensurePolling(): void {
    if (!this.pending || this.pollTimer !== null || this.polling) return;
    this.schedulePoll(this.nextPollDelay(this.pending));
  }

  clientId(): { value: string; source: 'build' | 'options' | 'none' } {
    if (this.clientIdOverride) return { value: this.clientIdOverride, source: 'options' };
    if (this.deps.config.clientId) return { value: this.deps.config.clientId, source: 'build' };
    return { value: '', source: 'none' };
  }

  /** An account's state, or (no account) the state of connecting one: in progress, or not started. */
  state(userId: number | null = null): AuthState {
    const account = userId === null ? null : this.accounts.get(userId);
    if (account) return account.state();
    if (this.pending) return { kind: 'authorizing', userCode: this.pending.userCode, verificationUri: this.pending.verificationUri, expiresAt: this.pending.expiresAt };
    return { kind: 'signed-out', clientIdConfigured: this.clientId().value !== '', problem: this.problem };
  }

  private changed(): void {
    this.deps.onChange(null);
  }

  async setClientId(clientId: string): Promise<void> {
    const trimmed = clientId.trim();
    if (trimmed && !CLIENT_ID_RE.test(trimmed)) throw new Error('That does not look like a GitHub App client ID (they start with "Iv"). Never paste the client secret.');
    this.clientIdOverride = trimmed;
    if (trimmed) await this.deps.sync.set({ [CLIENT_ID_KEY]: trimmed });
    else await this.deps.sync.remove(CLIENT_ID_KEY);
    this.problem = null;
    this.changed();
  }

  /** The client ID changed in Chrome Sync (saved, changed or cleared on another browser). */
  syncedClientId(value: unknown): void {
    const next = typeof value === 'string' && CLIENT_ID_RE.test(value) ? value : '';
    if (next === this.clientIdOverride) return;
    this.clientIdOverride = next;
    this.problem = null;
    this.changed();
  }

  /** Starts (or restarts) the device flow and returns the code to show. */
  async start(): Promise<AuthState> {
    const clientId = this.clientId().value;
    if (!clientId) {
      this.problem = { message: 'No GitHub App client ID is configured. Add it in Options.', restartable: false };
      this.changed();
      return this.state();
    }
    await this.cancel(false);
    this.problem = null;
    try {
      this.pending = await requestDeviceCode(this.deps.fetch, this.deps.config.oauthBase, clientId, this.deps.timers.now());
    } catch (error) {
      this.fail(error);
      return this.state();
    }
    await this.deps.session.set({ [PENDING_KEY]: this.pending });
    this.changed();
    this.schedulePoll(this.nextPollDelay(this.pending));
    return this.state();
  }

  async cancel(notify = true): Promise<void> {
    if (this.pollTimer !== null) this.deps.timers.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.pending = null;
    await this.deps.session.remove(PENDING_KEY);
    if (notify) this.changed();
  }

  private fail(error: unknown): void {
    this.problem =
      error instanceof DeviceFlowError
        ? { message: error.message, restartable: error.restartable }
        : { message: 'Sign-in failed unexpectedly. Try again.', restartable: true };
    this.changed();
  }

  private schedulePoll(delayMs: number): void {
    if (this.pollTimer !== null) this.deps.timers.clearTimeout(this.pollTimer);
    this.pollTimer = this.deps.timers.setTimeout(() => {
      this.pollTimer = null;
      void this.pollOnce();
    }, delayMs);
  }

  async pollOnce(): Promise<void> {
    const flow = this.pending;
    if (!flow || this.polling) return;
    this.polling = true;
    try {
      const result = await pollDeviceToken(this.deps.fetch, this.deps.config.oauthBase, flow, this.deps.timers.now());
      if (this.pending !== flow) return; // cancelled or restarted meanwhile
      if (result.kind === 'pending') {
        this.pending = { ...flow, intervalS: result.intervalS, lastPollAt: this.deps.timers.now() };
        // Persisting every round also keeps the service worker alive while the user is on github.com.
        await this.deps.session.set({ [PENDING_KEY]: this.pending });
        this.schedulePoll(this.nextPollDelay(this.pending));
        return;
      }
      this.pending = null;
      await this.deps.session.remove(PENDING_KEY);
      await this.adopt(result.token);
    } catch (error) {
      if (this.pending !== flow) return;
      this.pending = null;
      await this.deps.session.remove(PENDING_KEY);
      this.fail(error);
    } finally {
      this.polling = false;
    }
  }

  /** The code was entered: find out whose account it connected, then add it or renew it. */
  private async adopt(token: TokenSet): Promise<void> {
    const who = await whoIs(this.deps, token.accessToken);
    if (typeof who === 'string' || who.userId === null) {
      // Without knowing the account, the token cannot be filed under it (or kept apart from another account's).
      this.problem = { message: 'GitHub accepted the code but did not say which account it connected. Connect again.', restartable: true };
      this.changed();
      return;
    }
    const userId = who.userId;
    let account = this.accounts.get(userId);
    const added = !account;
    if (!account) {
      account = this.makeAccount(userId);
      this.accounts.set(userId, account);
      await this.saveAccounts();
    }
    this.problem = null;
    await account.adopt(token, who);
    this.changed();
    this.deps.onSignedIn(userId, added);
  }

  /** Forgets one account's authorization on this device. GitHub-side revocation is a link in Options (it needs the user). */
  async signOut(userId: number): Promise<void> {
    const account = this.accounts.get(userId);
    if (!account) return;
    await account.signOut();
    this.accounts.delete(userId);
    await this.saveAccounts();
    this.deps.onChange(userId);
    this.changed();
    this.deps.onSignedOut(userId, 'signout');
  }
}
