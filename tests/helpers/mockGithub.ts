import { apiRepo } from './repos';

/**
 * A small, faithful-enough GitHub: REST pagination with `Link` headers (per_page capped at 100), ETags and
 * 304s, rate-limit and auth failure modes, and the OAuth device flow. Used as a `fetch` in unit tests and
 * behind a local HTTP server in the browser tests.
 */
export interface MockInstallation {
  id: number;
  account: string;
  type: 'User' | 'Organization';
  selection: 'all' | 'selected';
  /** 1-based repo numbers (see apiRepo) visible through this installation. */
  repos: number[];
  failWith?: 403 | 404;
  suspended?: boolean;
}

export interface MockGitHubOptions {
  /** Repo numbers returned by /user/repos. */
  userRepos: number[];
  installations?: MockInstallation[];
  token?: string;
  login?: string;
  /** Repository number -> REST repository object. Defaults to the deterministic piRepo sample set. */
  repo?: (n: number) => unknown;
}

export interface MockResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface RequestLog {
  method: string;
  path: string;
  query: string;
  authorization: string | null;
  ifNoneMatch: string | null;
  status: number;
}

type DeviceStep = 'pending' | 'slow_down' | 'denied' | 'expired' | 'success';

export class MockGitHub {
  userRepos: number[];
  installations: MockInstallation[];
  token: string;
  login: string;
  /** GitHub user ID answered by /user (change it with `login` to play a second account). */
  userId = 1001;
  log: RequestLog[] = [];
  /** When set, every API request fails like this until cleared. */
  failure:
    | null
    | { kind: 'rate-limit'; resetEpochSeconds: number }
    | { kind: 'secondary'; retryAfter: number }
    | { kind: 'unauthorized' }
    | { kind: 'server-error'; onPath?: string; afterPage?: number }
    /** Connections are dropped (the HTTP server destroys the socket; the fetch mock rejects). */
    | { kind: 'network' } = null;
  /** Tamper with Link headers to prove the client defends itself. */
  linkMode: 'normal' | 'foreign-host' | 'loop' = 'normal';
  deviceSteps: DeviceStep[] = ['pending', 'success'];
  deviceCodeRequests = 0;
  tokenRequests: Record<string, string>[] = [];
  refreshAccepted = false;
  issuedToken: string;
  private readonly repo: (n: number) => unknown;

  constructor(options: MockGitHubOptions) {
    this.repo = options.repo ?? apiRepo;
    this.userRepos = options.userRepos;
    this.installations = options.installations ?? [];
    this.token = options.token ?? 'ghu_mockUserToken0000000000000000000000';
    this.issuedToken = this.token;
    this.login = options.login ?? 'jd2005l';
  }

  private etagFor(body: string): string {
    let h = 2166136261;
    for (let i = 0; i < body.length; i++) h = Math.imul(h ^ body.charCodeAt(i), 16777619);
    return `W/"${(h >>> 0).toString(16)}"`;
  }

  private paginate(base: string, path: string, query: URLSearchParams, total: number): { start: number; end: number; link: string | null } {
    const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? 30)));
    const page = Math.max(1, Number(query.get('page') ?? 1));
    const start = (page - 1) * perPage;
    const end = Math.min(total, start + perPage);
    const lastPage = Math.max(1, Math.ceil(total / perPage));
    const linkFor = (p: number) => {
      const q = new URLSearchParams(query);
      q.set('page', String(p));
      return `${base}${path}?${q.toString()}`;
    };
    const parts: string[] = [];
    if (page < lastPage) {
      let next = linkFor(page + 1);
      if (this.linkMode === 'foreign-host') next = next.replace(/^https?:\/\/[^/]+/, 'https://evil.example');
      if (this.linkMode === 'loop') next = linkFor(1);
      parts.push(`<${next}>; rel="next"`, `<${linkFor(lastPage)}>; rel="last"`);
    }
    if (page > 1) parts.push(`<${linkFor(1)}>; rel="first"`, `<${linkFor(page - 1)}>; rel="prev"`);
    return { start, end, link: parts.length ? parts.join(', ') : null };
  }

  private json(status: number, value: unknown, extra: Record<string, string> = {}): MockResponse {
    return { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra }, body: JSON.stringify(value) };
  }

  private rateHeaders(): Record<string, string> {
    return { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '1900000000', 'x-ratelimit-resource': 'core' };
  }

  /** `apiBase` and `oauthBase` are the URL prefixes the extension was built with. */
  handle(method: string, url: string, headers: Record<string, string | undefined>, body: string, bases: { apiBase: string; oauthBase: string }): MockResponse {
    const parsed = new URL(url);
    const authorization = headers.authorization ?? headers.Authorization ?? null;
    const ifNoneMatch = headers['if-none-match'] ?? headers['If-None-Match'] ?? null;
    let response: MockResponse;
    if (url.startsWith(bases.oauthBase + '/login/')) {
      response = this.handleOAuth(parsed.pathname.slice(new URL(bases.oauthBase).pathname.replace(/\/$/, '').length), body, headers);
    } else if (url.startsWith(bases.apiBase + '/')) {
      const apiPath = parsed.pathname.slice(new URL(bases.apiBase).pathname.replace(/\/$/, '').length);
      response = this.handleApi(bases.apiBase, apiPath, parsed.searchParams, authorization, ifNoneMatch);
    } else {
      response = this.json(404, { message: 'Not Found' });
    }
    this.log.push({ method, path: parsed.pathname, query: parsed.search, authorization, ifNoneMatch, status: response.status });
    return response;
  }

  private handleApi(apiBase: string, path: string, query: URLSearchParams, authorization: string | null, ifNoneMatch: string | null): MockResponse {
    if (authorization !== `Bearer ${this.issuedToken}` || this.failure?.kind === 'unauthorized') {
      return this.json(401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
    }
    if (this.failure?.kind === 'rate-limit') {
      return this.json(403, { message: 'API rate limit exceeded for user ID 1.' }, { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(this.failure.resetEpochSeconds) });
    }
    if (this.failure?.kind === 'secondary') {
      return this.json(403, { message: 'You have exceeded a secondary rate limit.' }, { 'retry-after': String(this.failure.retryAfter) });
    }
    if (this.failure?.kind === 'server-error' && (!this.failure.onPath || path === this.failure.onPath) && Number(query.get('page') ?? 1) > (this.failure.afterPage ?? 0)) {
      return this.json(502, { message: 'Server Error' });
    }

    let result: MockResponse;
    if (path === '/user') {
      result = this.json(200, { login: this.login, id: this.userId, type: 'User' }, this.rateHeaders());
    } else if (path === '/user/repos') {
      const { start, end, link } = this.paginate(apiBase, path, query, this.userRepos.length);
      result = this.json(200, this.userRepos.slice(start, end).map((n) => this.repo(n)), { ...this.rateHeaders(), ...(link ? { link } : {}) });
    } else if (path === '/user/installations') {
      const { start, end, link } = this.paginate(apiBase, path, query, this.installations.length);
      const installations = this.installations.slice(start, end).map((i) => ({
        id: i.id,
        account: { login: i.account, type: i.type, avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' },
        repository_selection: i.selection,
        html_url: i.type === 'Organization' ? `https://github.com/organizations/${i.account}/settings/installations/${i.id}` : `https://github.com/settings/installations/${i.id}`,
        target_type: i.type,
        suspended_at: i.suspended ? '2026-09-01T00:00:00Z' : null,
        permissions: { metadata: 'read' },
      }));
      result = this.json(200, { total_count: this.installations.length, installations }, { ...this.rateHeaders(), ...(link ? { link } : {}) });
    } else {
      const match = /^\/user\/installations\/(\d+)\/repositories$/.exec(path);
      const installation = match ? this.installations.find((i) => i.id === Number(match[1])) : undefined;
      if (!installation) return this.json(404, { message: 'Not Found' });
      if (installation.failWith) return this.json(installation.failWith, { message: installation.failWith === 403 ? 'Resource protected by organization SAML enforcement.' : 'Not Found' });
      const { start, end, link } = this.paginate(apiBase, path, query, installation.repos.length);
      result = this.json(200, { total_count: installation.repos.length, repositories: installation.repos.slice(start, end).map((n) => this.repo(n)) }, { ...this.rateHeaders(), ...(link ? { link } : {}) });
    }
    // Like GitHub: the ETag covers the body only, 200s send it weak, and authenticated 304s carry no Link header
    // (and come back with a strong ETag).
    const strong = this.etagFor(result.body).slice(2);
    if (ifNoneMatch && ifNoneMatch.replace(/^W\//, '') === strong) return { status: 304, headers: { etag: strong, ...this.rateHeaders() }, body: '' };
    result.headers.etag = `W/${strong}`;
    return result;
  }

  private handleOAuth(path: string, body: string, headers: Record<string, string | undefined>): MockResponse {
    const form = new URLSearchParams(body);
    const accept = headers.accept ?? headers.Accept ?? '';
    if (!accept.includes('application/json')) return { status: 200, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'error=accept_header_missing' };
    if (path === '/login/device/code') {
      this.deviceCodeRequests++;
      if (!form.get('client_id')) return this.json(400, { error: 'incorrect_client_credentials' });
      return this.json(200, { device_code: `dc_${this.deviceCodeRequests}`, user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 });
    }
    if (path === '/login/oauth/access_token') {
      this.tokenRequests.push(Object.fromEntries(form.entries()));
      if (form.get('client_secret')) return this.json(200, { error: 'unexpected_secret', error_description: 'The extension must never send a client secret.' });
      if (form.get('grant_type') === 'refresh_token') {
        if (!this.refreshAccepted) return this.json(200, { error: 'incorrect_client_credentials', error_description: 'The client_id and/or client_secret passed are incorrect.' });
        this.issuedToken = `ghu_refreshed${this.tokenRequests.length}`;
        return this.json(200, { access_token: this.issuedToken, token_type: 'bearer', scope: '', expires_in: 28800, refresh_token: `ghr_r${this.tokenRequests.length}`, refresh_token_expires_in: 15811200 });
      }
      const step = this.deviceSteps.shift() ?? 'pending';
      switch (step) {
        case 'pending':
          return this.json(200, { error: 'authorization_pending', error_description: 'The authorization request is still pending.' });
        case 'slow_down':
          return this.json(200, { error: 'slow_down', error_description: 'Too many requests.', interval: 6 });
        case 'denied':
          return this.json(200, { error: 'access_denied', error_description: 'The user has denied your application access.' });
        case 'expired':
          return this.json(200, { error: 'expired_token', error_description: 'The device code has expired.' });
        case 'success':
          this.issuedToken = this.token;
          return this.json(200, { access_token: this.token, token_type: 'bearer', scope: '', expires_in: 28800, refresh_token: 'ghr_mockRefresh', refresh_token_expires_in: 15811200 });
      }
    }
    return this.json(404, { error: 'not_found' });
  }

  /** A `fetch` implementation backed by this mock. */
  fetch(bases: { apiBase: string; oauthBase: string }) {
    return (input: string, init?: RequestInit): Promise<Response> => {
      if (this.failure?.kind === 'network') return Promise.reject(new TypeError('Failed to fetch'));
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
      const body = typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : '';
      const result = this.handle(init?.method ?? 'GET', input, headers, body, bases);
      return Promise.resolve(new Response(result.status === 304 ? null : result.body, { status: result.status, headers: result.headers }));
    };
  }
}

/** The canonical release fixture: 225 repos in /user/repos (3 pages) plus installations that overlap and extend it. */
export function releaseFixture(): MockGitHub {
  const userRepos = Array.from({ length: 225 }, (_, i) => i + 1);
  return new MockGitHub({
    userRepos,
    installations: [
      { id: 71, account: 'jd2005l', type: 'User', selection: 'all', repos: userRepos.filter((n) => n % 4 === 0) },
      // Overlaps /user/repos and adds 30 repos only visible through this installation (226..255).
      { id: 72, account: 'acme-corp', type: 'Organization', selection: 'all', repos: [...userRepos.filter((n) => n % 4 === 1), ...Array.from({ length: 30 }, (_, i) => 226 + i)] },
    ],
  });
}
