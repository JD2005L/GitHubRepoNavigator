import type { InstallationSummary, InventorySnapshot, InventoryStatus, RepoHint, RepoRecord } from '../shared/types';
import type { AccountAuth } from './auth/authManager';
import { GitHubClient, GitHubError, type CachedPage, type FetchLike, type RateLimitInfo } from './github/client';
import { fetchRepoHints } from './github/hints';
import { fetchInventory, type InstallationIssue } from './github/inventory';
import type { StorageAreaLike, Timers } from './layoutStore';

export const CACHE_KEY = 'inventory.cache';
export const ETAGS_KEY = 'inventory.etags';
export const RATE_LIMIT_KEY = 'inventory.rateLimitedUntil';
/** Refresh when a view opens and the cache is older than this. */
export const STALE_MS = 10 * 60_000;
/**
 * Version of the stored ETag pages and of the normalizer that produced them. Bump it whenever normalizeRepo or
 * the record shape changes, so unchanged (304) pages are not served in an old shape forever.
 */
export const ETAG_FORMAT = 2;

interface CacheRecord {
  repos: RepoRecord[];
  fetchedAt: number;
  installations: InstallationSummary[];
  installationIssues: { account: string; kind: string }[];
  ssoHiddenOrganizations: string[];
  pages: number;
  notModifiedPages: number;
  rejected: number;
}

/** Stored form of a cached page: repository pages keep only IDs (the records live once, in the cache). */
type StoredPage = { etag: string; next: string | null; ids: (number | null)[] } | { etag: string; next: string | null; items: unknown[] };

export interface InventoryDeps {
  local: StorageAreaLike;
  fetch: FetchLike;
  timers: Timers;
  apiBase: string;
  auth: Pick<AccountAuth, 'token' | 'onUnauthorized' | 'isSignedIn'>;
  onChange(snapshot: InventorySnapshot): void;
}

function parseCache(value: unknown): CacheRecord | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Partial<CacheRecord>;
  if (!Array.isArray(c.repos) || typeof c.fetchedAt !== 'number') return null;
  return {
    repos: c.repos,
    fetchedAt: c.fetchedAt,
    installations: Array.isArray(c.installations) ? c.installations : [],
    installationIssues: Array.isArray(c.installationIssues) ? c.installationIssues : [],
    ssoHiddenOrganizations: Array.isArray(c.ssoHiddenOrganizations) ? c.ssoHiddenOrganizations : [],
    pages: typeof c.pages === 'number' ? c.pages : 0,
    notModifiedPages: typeof c.notModifiedPages === 'number' ? c.notModifiedPages : 0,
    rejected: typeof c.rejected === 'number' ? c.rejected : 0,
  };
}

function isRepoRecord(value: unknown): value is RepoRecord {
  return !!value && typeof value === 'object' && typeof (value as RepoRecord).id === 'number' && typeof (value as RepoRecord).owner === 'string' && typeof (value as RepoRecord).name === 'string';
}

function packPage(page: CachedPage<unknown>): StoredPage {
  const repoPage = page.items.length > 0 && page.items.every((x) => x === null || isRepoRecord(x)) && page.items.some(isRepoRecord);
  if (repoPage) return { etag: page.etag, next: page.next, ids: page.items.map((x) => (x === null ? null : (x as RepoRecord).id)) };
  return { etag: page.etag, next: page.next, items: page.items };
}

/** Rebuilds stored pages against the current cache; any page that cannot be rebuilt exactly is dropped (refetched). */
function unpackPages(stored: unknown, repos: readonly RepoRecord[]): Map<string, CachedPage<unknown>> {
  const pages = new Map<string, CachedPage<unknown>>();
  if (!stored || typeof stored !== 'object') return pages;
  const record = stored as { format?: unknown; pages?: unknown };
  if (record.format !== ETAG_FORMAT || !record.pages || typeof record.pages !== 'object') return pages;
  const byId = new Map(repos.map((r) => [r.id, r]));
  for (const [url, value] of Object.entries(record.pages as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const page = value as Partial<{ etag: unknown; next: unknown; ids: unknown; items: unknown }>;
    if (typeof page.etag !== 'string' || (page.next !== null && typeof page.next !== 'string')) continue;
    if (Array.isArray(page.ids)) {
      const items: (RepoRecord | null)[] = [];
      let complete = true;
      for (const id of page.ids) {
        if (id === null) items.push(null);
        else if (typeof id === 'number' && byId.has(id)) items.push(byId.get(id)!);
        else complete = false;
      }
      if (complete) pages.set(url, { etag: page.etag, next: page.next, items });
    } else if (Array.isArray(page.items)) {
      pages.set(url, { etag: page.etag, next: page.next, items: page.items });
    }
  }
  return pages;
}

/**
 * Keeps the device-local repository cache. A refresh only replaces the cache when every page succeeded, so a
 * failure part-way through never makes repositories disappear.
 */
export class InventoryManager {
  private cache: CacheRecord | null = null;
  private status: InventoryStatus = { kind: 'idle' };
  private running: Promise<void> | null = null;
  /** Bumped by clear(); a refresh started under an older generation must not write anything. */
  private generation = 0;
  private runningGeneration = -1;
  /** Survives worker restarts so a rate-limited user is not hit again by every new worker. */
  private rateLimitedUntil = 0;
  rateLimit: RateLimitInfo = { limit: null, remaining: null, resetAt: null };
  private idSet: Set<number> = new Set();

  constructor(private readonly deps: InventoryDeps) {}

  async init(): Promise<void> {
    const items = await this.deps.local.get([CACHE_KEY, RATE_LIMIT_KEY]);
    this.cache = parseCache(items[CACHE_KEY]);
    this.idSet = new Set(this.cache?.repos.map((r) => r.id) ?? []);
    const until = items[RATE_LIMIT_KEY];
    if (typeof until === 'number' && until > this.deps.timers.now()) {
      this.rateLimitedUntil = until;
      this.status = { kind: 'rate-limited', resetAt: until };
    }
  }

  snapshot(): InventorySnapshot {
    return {
      repos: this.cache?.repos ?? [],
      fetchedAt: this.cache?.fetchedAt ?? null,
      installations: this.cache?.installations ?? [],
      status: this.status,
    };
  }

  details(): CacheRecord | null {
    return this.cache;
  }

  ids(): ReadonlySet<number> {
    return this.idSet;
  }

  isStale(): boolean {
    return !this.cache || this.deps.timers.now() - this.cache.fetchedAt > STALE_MS;
  }

  private setStatus(status: InventoryStatus): void {
    this.status = status;
    this.deps.onChange(this.snapshot());
  }

  /** Single-flight refresh. Resolves when done; never throws. Non-forced refreshes respect a rate limit. */
  refresh(options: { force?: boolean } = {}): Promise<void> {
    if (this.running) {
      // A run from before a sign-out/clear must not satisfy a request made after it.
      if (this.runningGeneration === this.generation) return this.running;
      return this.running.then(() => this.refresh(options));
    }
    if (!options.force && this.deps.timers.now() < this.rateLimitedUntil) {
      if (this.status.kind !== 'rate-limited') this.setStatus({ kind: 'rate-limited', resetAt: this.rateLimitedUntil });
      return Promise.resolve();
    }
    this.runningGeneration = this.generation;
    this.running = this.run(this.generation)
      .catch(() => this.setStatus({ kind: 'error', message: 'Refreshing repositories failed unexpectedly.' }))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async run(generation: number): Promise<void> {
    if (!this.deps.auth.isSignedIn()) return;
    const stale = () => generation !== this.generation || !this.deps.auth.isSignedIn();
    this.setStatus({ kind: 'refreshing' });
    for (let attempt = 0; attempt < 2; attempt++) {
      const access = await this.deps.auth.token();
      if (stale()) return;
      if (!('token' in access)) {
        // Transient: GitHub's token endpoint is unreachable, so treat it like being offline (the saved list stays).
        this.setStatus(access.reason === 'transient' ? { kind: 'offline' } : { kind: 'idle' });
        return;
      }
      const stored = await this.deps.local.get(ETAGS_KEY);
      if (stale()) return;
      const etags = unpackPages(stored[ETAGS_KEY], this.cache?.repos ?? []);
      const visited = new Set<string>();
      const client = new GitHubClient({
        apiBase: this.deps.apiBase,
        token: access.token,
        fetch: (url, init) => {
          visited.add(url);
          return this.deps.fetch(url, init);
        },
        etags,
        now: () => this.deps.timers.now(),
      });
      let result: Awaited<ReturnType<typeof fetchInventory>>;
      try {
        result = await fetchInventory(client);
      } catch (error) {
        if (stale()) return;
        this.rateLimit = client.lastRateLimit;
        if (error instanceof GitHubError && error.kind === 'unauthorized' && attempt === 0) {
          if (await this.deps.auth.onUnauthorized()) continue; // refreshed: retry exactly once
          if (stale()) return;
          this.setStatus({ kind: 'idle' });
          return;
        }
        if (error instanceof GitHubError && error.kind === 'rate-limited' && error.resetAt) await this.rememberRateLimit(error.resetAt);
        this.setStatus(this.statusFor(error));
        return;
      }
      if (stale()) return; // signed out / cleared while fetching: drop everything
      this.rateLimit = client.lastRateLimit;
      await this.rememberRateLimit(0);
      const saved = await this.store(result.repos, result.installations, result.installationIssues, [...client.ssoHiddenOrganizations], result.pages, client.notModified, result.rejected, etags, visited);
      if (stale()) return;
      this.setStatus(saved ? { kind: 'idle' } : { kind: 'error', message: 'The repository list could not be saved on this device (browser storage is full). It is shown but not kept.' });
      return;
    }
    this.setStatus({ kind: 'idle' });
  }

  /**
   * Descriptions, languages and topics for the cached repositories, fetched live for suggesting sections. Uses
   * its own empty ETag map (no conditional requests, nothing cached) and returns hints only for repositories
   * already in the inventory. Throws an Error with a user-facing message.
   */
  async hints(): Promise<RepoHint[]> {
    if (!this.deps.auth.isSignedIn()) throw new Error('Connect GitHub first.');
    if (this.deps.timers.now() < this.rateLimitedUntil) throw new Error(`GitHub rate limit reached. Try again after ${new Date(this.rateLimitedUntil).toLocaleTimeString()}.`);
    for (let attempt = 0; attempt < 2; attempt++) {
      const access = await this.deps.auth.token();
      if (!('token' in access)) throw new Error(access.reason === 'transient' ? 'GitHub could not be reached. Check your connection.' : 'Connect GitHub first.');
      const client = new GitHubClient({ apiBase: this.deps.apiBase, token: access.token, fetch: this.deps.fetch, etags: new Map(), now: () => this.deps.timers.now() });
      try {
        const hints = await fetchRepoHints(client);
        this.rateLimit = client.lastRateLimit;
        return [...hints.values()].filter((h) => this.idSet.has(h.id));
      } catch (error) {
        this.rateLimit = client.lastRateLimit;
        if (error instanceof GitHubError && error.kind === 'unauthorized' && attempt === 0 && (await this.deps.auth.onUnauthorized())) continue;
        if (error instanceof GitHubError && error.kind === 'rate-limited' && error.resetAt) await this.rememberRateLimit(error.resetAt);
        throw new Error(error instanceof GitHubError ? error.message : 'Reading repository details from GitHub failed.', { cause: error });
      }
    }
    throw new Error('GitHub rejected the authorization. Reconnect in Options.');
  }

  private async rememberRateLimit(until: number): Promise<void> {
    if (until === this.rateLimitedUntil) return;
    this.rateLimitedUntil = until;
    try {
      if (until) await this.deps.local.set({ [RATE_LIMIT_KEY]: until });
      else await this.deps.local.remove(RATE_LIMIT_KEY);
    } catch {
      // Best effort: the in-memory value still applies to this worker.
    }
  }

  private statusFor(error: unknown): InventoryStatus {
    if (error instanceof GitHubError) {
      if (error.kind === 'rate-limited' && error.resetAt) return { kind: 'rate-limited', resetAt: error.resetAt };
      if (error.kind === 'offline') return { kind: 'offline' };
      if (error.kind === 'unauthorized') return { kind: 'error', message: 'GitHub rejected the authorization again. Reconnect in Options.' };
      return { kind: 'error', message: error.message };
    }
    return { kind: 'error', message: 'Refreshing repositories failed unexpectedly.' };
  }

  /** Replaces the cache (in memory first, so the list is shown even if storage is full). Returns false when not saved. */
  private async store(
    repos: RepoRecord[],
    installations: InstallationSummary[],
    issues: InstallationIssue[],
    ssoHiddenOrganizations: string[],
    pages: number,
    notModifiedPages: number,
    rejected: number,
    etags: Map<string, CachedPage<unknown>>,
    visited: ReadonlySet<string>,
  ): Promise<boolean> {
    this.cache = {
      repos,
      fetchedAt: this.deps.timers.now(),
      installations,
      installationIssues: issues.map((i) => ({ account: i.installation.account, kind: i.kind })),
      ssoHiddenOrganizations,
      pages,
      notModifiedPages,
      rejected,
    };
    this.idSet = new Set(repos.map((r) => r.id));
    // Keep ETags only for pages this complete refresh used, with repository pages reduced to IDs.
    const packed: Record<string, StoredPage> = {};
    for (const [url, page] of etags) if (visited.has(url)) packed[url] = packPage(page);
    try {
      await this.deps.local.set({ [CACHE_KEY]: this.cache, [ETAGS_KEY]: { format: ETAG_FORMAT, pages: packed } });
      return true;
    } catch {
      await this.deps.local.remove(ETAGS_KEY).catch(() => undefined);
      return false;
    }
  }

  /** Sign-out / different user: forget everything fetched with the old authorization. */
  async clear(): Promise<void> {
    this.generation++;
    this.cache = null;
    this.idSet = new Set();
    this.status = { kind: 'idle' };
    await this.deps.local.remove([CACHE_KEY, ETAGS_KEY]);
    this.deps.onChange(this.snapshot());
  }
}
