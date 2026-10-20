/**
 * Minimal GitHub REST client for the service worker.
 *
 * - Sends the token only to the configured API origin; a `Link` header pointing anywhere else is refused.
 * - Per-URL conditional requests: a 304 reuses the page we stored for that ETag (304s do not count against
 *   the primary rate limit).
 * - Classifies failures so callers can show signed-out / expired / rate-limited / offline states.
 * - Never includes the token (or request headers) in thrown errors.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type GitHubErrorKind = 'unauthorized' | 'rate-limited' | 'offline' | 'forbidden' | 'not-found' | 'http' | 'invalid-response' | 'pagination';

export class GitHubError extends Error {
  constructor(
    readonly kind: GitHubErrorKind,
    message: string,
    readonly status: number | null = null,
    readonly resetAt: number | null = null,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface CachedPage<T> {
  etag: string;
  next: string | null;
  items: T[];
}

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  resetAt: number | null;
}

/** Newest REST API version (released 2026-03-12); 2022-11-28 remains supported until 2028-03-10. */
export const API_VERSION = '2026-03-10';

export interface ClientOptions {
  apiBase: string;
  token: string;
  fetch: FetchLike;
  /** URL -> last good page. Shared across a refresh; persisted by the caller only after a complete refresh. */
  etags: Map<string, CachedPage<unknown>>;
  now?: () => number;
}

/** Parses RFC 8288 Link headers. URLs are matched as <...> tokens, so commas inside a URL cannot split it. */
export function parseLinkHeader(header: string | null): Record<string, string> {
  const links: Record<string, string> = {};
  if (!header) return links;
  for (const match of header.matchAll(/<([^>]*)>((?:\s*;\s*[^;,<]*)*)/g)) {
    const rel = /;\s*rel\s*=\s*"?([^";,]+)"?/i.exec(match[2] ?? '');
    if (!rel) continue;
    for (const name of rel[1]!.trim().split(/\s+/)) links[name.toLowerCase()] = match[1]!;
  }
  return links;
}

function headerNumber(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function readRateLimit(headers: Headers): RateLimitInfo {
  const reset = headerNumber(headers, 'x-ratelimit-reset');
  return {
    limit: headerNumber(headers, 'x-ratelimit-limit'),
    remaining: headerNumber(headers, 'x-ratelimit-remaining'),
    resetAt: reset === null ? null : reset * 1000,
  };
}

/** Returns the time the client may retry, or null when a 403/429 is not a rate limit. */
export function rateLimitResetAt(status: number, headers: Headers, bodyText: string, now: number): number | null {
  if (status !== 403 && status !== 429) return null;
  const retryAfter = headerNumber(headers, 'retry-after');
  if (retryAfter !== null) return now + Math.max(1, retryAfter) * 1000;
  const remaining = headerNumber(headers, 'x-ratelimit-remaining');
  const reset = headerNumber(headers, 'x-ratelimit-reset');
  if (remaining === 0 && reset !== null) return Math.max(now + 1000, reset * 1000);
  if (status === 429 || /rate limit/i.test(bodyText)) return now + 60_000; // secondary limit without hints
  return null;
}

export class GitHubClient {
  readonly apiOrigin: string;
  lastRateLimit: RateLimitInfo = { limit: null, remaining: null, resetAt: null };
  /** Organizations GitHub withheld from listings because they need an active SAML SSO session. */
  readonly ssoHiddenOrganizations = new Set<string>();
  requests = 0;
  notModified = 0;

  constructor(private readonly options: ClientOptions) {
    this.apiOrigin = new URL(options.apiBase).origin;
  }

  url(path: string): string {
    return `${this.options.apiBase.replace(/\/$/, '')}${path}`;
  }

  /** Only URLs on the API origin may carry the token. */
  assertApiUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new GitHubError('pagination', 'GitHub returned an invalid pagination link.');
    }
    if (parsed.origin !== this.apiOrigin) throw new GitHubError('pagination', 'GitHub returned a pagination link to an unexpected host.');
  }

  async getJson(url: string): Promise<unknown> {
    const response = await this.send(url, null);
    return this.parseJson(response);
  }

  async getPage<T>(url: string, extract: (json: unknown) => T[]): Promise<{ items: T[]; next: string | null; fromCache: boolean }> {
    const cached = this.options.etags.get(url) as CachedPage<T> | undefined;
    let response = await this.send(url, cached?.etag ?? null);
    if (response.status === 304 && cached) {
      // GitHub's ETag covers the body only and an authenticated 304 has no Link header. A full page that was the
      // last page may have gained a following page without changing itself, so only a fresh Link header can tell.
      const perPage = Number(new URL(url).searchParams.get('per_page') ?? 30);
      if (cached.next !== null || cached.items.length < perPage) {
        this.notModified++;
        return { items: cached.items, next: cached.next, fromCache: true };
      }
      response = await this.send(url, null);
    }
    if (response.status === 304) throw new GitHubError('invalid-response', 'GitHub answered 304 for a page that is not cached.', 304);
    const json = await this.parseJson(response);
    const items = extract(json);
    const next = parseLinkHeader(response.headers.get('link')).next ?? null;
    if (next) this.assertApiUrl(next);
    const etag = response.headers.get('etag');
    if (etag) this.options.etags.set(url, { etag, next, items });
    else this.options.etags.delete(url);
    return { items, next, fromCache: false };
  }

  private async parseJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new GitHubError('invalid-response', 'GitHub returned a response that is not JSON.', response.status);
    }
  }

  private async send(url: string, etag: string | null): Promise<Response> {
    this.assertApiUrl(url);
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.options.token}`,
      'X-GitHub-Api-Version': API_VERSION,
    };
    if (etag) headers['If-None-Match'] = etag;
    let response: Response;
    try {
      this.requests++;
      // Redirects are never followed with the token attached.
      response = await this.options.fetch(url, { method: 'GET', headers, cache: 'no-store', credentials: 'omit', redirect: 'manual' });
    } catch {
      throw new GitHubError('offline', 'GitHub could not be reached. Check your connection.');
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400 && response.status !== 304)) {
      throw new GitHubError('http', 'GitHub answered with an unexpected redirect.', response.status || null);
    }
    this.lastRateLimit = readRateLimit(response.headers);
    const sso = response.headers.get('x-github-sso');
    if (sso && /partial-results/i.test(sso)) {
      const orgs = /organizations=([^;]+)/i.exec(sso)?.[1] ?? '';
      for (const org of orgs.split(',')) if (/^[0-9A-Za-z_-]{1,100}$/.test(org.trim())) this.ssoHiddenOrganizations.add(org.trim());
      if (!orgs) this.ssoHiddenOrganizations.add('(unknown)');
    }
    if (response.ok || response.status === 304) return response;

    const now = (this.options.now ?? Date.now)();
    const body = await response.text().catch(() => '');
    if (response.status === 401) throw new GitHubError('unauthorized', 'GitHub no longer accepts this authorization.', 401);
    const resetAt = rateLimitResetAt(response.status, response.headers, body, now);
    if (resetAt !== null) throw new GitHubError('rate-limited', 'GitHub rate limit reached.', response.status, resetAt);
    if (response.status === 403) throw new GitHubError('forbidden', 'GitHub refused access to this resource.', 403);
    if (response.status === 404) throw new GitHubError('not-found', 'GitHub could not find this resource.', 404);
    throw new GitHubError('http', `GitHub responded with HTTP ${response.status}.`, response.status);
  }
}

/** Follows `rel="next"` until it is absent. Refuses loops and runaway pagination. */
export async function collectAllPages<T>(
  client: GitHubClient,
  firstUrl: string,
  extract: (json: unknown) => T[],
  maxPages = 2000,
): Promise<{ items: T[]; pages: number }> {
  const items: T[] = [];
  const visited = new Set<string>();
  let url: string | null = firstUrl;
  while (url) {
    if (visited.has(url)) throw new GitHubError('pagination', 'GitHub pagination looped back to a page already read.');
    if (visited.size >= maxPages) throw new GitHubError('pagination', `Stopped after ${maxPages} pages of results.`);
    visited.add(url);
    const page: { items: T[]; next: string | null } = await client.getPage(url, extract);
    items.push(...page.items);
    url = page.next;
  }
  return { items, pages: visited.size };
}
