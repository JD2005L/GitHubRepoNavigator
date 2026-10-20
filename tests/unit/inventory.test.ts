import { describe, expect, it } from 'vitest';
import { GitHubClient, GitHubError, parseLinkHeader, rateLimitResetAt, type CachedPage } from '../../src/background/github/client';
import { fetchInventory, normalizeRepo } from '../../src/background/github/inventory';
import { MockGitHub, releaseFixture } from '../helpers/mockGithub';
import { apiRepo } from '../helpers/repos';

const bases = { apiBase: 'https://api.github.com', oauthBase: 'https://github.com' };

function clientFor(mock: MockGitHub, etags = new Map<string, CachedPage<unknown>>()) {
  return new GitHubClient({ apiBase: bases.apiBase, token: mock.token, fetch: mock.fetch(bases), etags, now: () => 1_000_000 });
}

describe('complete inventory (release criterion: >= 225 repos across multiple pages)', () => {
  it('follows rel="next" through every page and includes repos beyond pages 1 and 2', async () => {
    const mock = releaseFixture();
    const result = await fetchInventory(clientFor(mock));

    const userRepoPages = mock.log.filter((r) => r.path === '/user/repos');
    expect(userRepoPages.map((r) => new URLSearchParams(r.query).get('page') ?? '1')).toEqual(['1', '2', '3']);
    expect(userRepoPages.every((r) => new URLSearchParams(r.query).get('per_page') === '100')).toBe(true);

    // 225 from /user/repos + 30 only reachable through the organization installation.
    expect(result.repos).toHaveLength(255);
    const ids = new Set(result.repos.map((r) => r.id));
    for (const n of [1, 100, 101, 200, 201, 225, 226, 255]) expect(ids.has(apiRepo(n).id)).toBe(true);
    // Page 3 of /user/repos holds items 201..225.
    const page3 = Array.from({ length: 25 }, (_, i) => apiRepo(201 + i).id);
    expect(page3.every((id) => ids.has(id))).toBe(true);
    expect(result.installations.map((i) => i.account)).toEqual(['jd2005l', 'acme-corp']);
    expect(result.rejected).toBe(0);
  });

  it('deduplicates by immutable ID across endpoints', async () => {
    const mock = releaseFixture();
    const result = await fetchInventory(clientFor(mock));
    expect(new Set(result.repos.map((r) => r.id)).size).toBe(result.repos.length);
  });

  it('never stores fields beyond navigation metadata, including in the ETag page cache', async () => {
    const mock = releaseFixture();
    const etags = new Map<string, CachedPage<unknown>>();
    const result = await fetchInventory(clientFor(mock, etags));
    expect(etags.size).toBeGreaterThan(3);
    const stored = JSON.stringify([...etags.values()]) + JSON.stringify(result);
    expect(stored).not.toMatch(/Description|secret-topic|permissions|default_branch|full_name|html_url/);
    const repo = normalizeRepo(apiRepo(3));
    expect(Object.keys(repo!).sort()).toEqual(['archived', 'fork', 'id', 'name', 'nodeId', 'owner', 'ownerAvatarUrl', 'private', 'pushedAt', 'visibility']);
    expect(JSON.stringify(repo)).not.toMatch(/Description|secret-topic|permissions/);
  });

  it('rejects names and owners that are not real GitHub identifiers and non-GitHub avatars', () => {
    expect(normalizeRepo({ ...apiRepo(1), name: '<img src=x onerror=alert(1)>' })).toBeNull();
    expect(normalizeRepo({ ...apiRepo(1), owner: { login: 'a/../b' } })).toBeNull();
    expect(normalizeRepo({ ...apiRepo(1), name: '..' })).toBeNull();
    expect(normalizeRepo({ ...apiRepo(1), id: -4 })).toBeNull();
    expect(normalizeRepo({ ...apiRepo(1), owner: { login: 'ok', avatar_url: 'javascript:alert(1)' } })!.ownerAvatarUrl).toBeNull();
    expect(normalizeRepo({ ...apiRepo(1), owner: { login: 'ok', avatar_url: 'https://avatars.githubusercontent.com.evil.example/u/1' } })!.ownerAvatarUrl).toBeNull();
  });

  it('reuses ETag-matched pages (304) and still reads every page', async () => {
    const mock = releaseFixture();
    const etags = new Map<string, CachedPage<unknown>>();
    await fetchInventory(clientFor(mock, etags));
    mock.log = [];
    const client = clientFor(mock, etags);
    const second = await fetchInventory(client);
    expect(second.repos).toHaveLength(255);
    expect(mock.log.every((r) => r.status === 304)).toBe(true);
    expect(mock.log.every((r) => r.ifNoneMatch)).toBe(true);
    expect(client.notModified).toBe(mock.log.length);
  });

  it('picks up changes on later pages even when page 1 is unchanged', async () => {
    const mock = releaseFixture();
    const etags = new Map<string, CachedPage<unknown>>();
    await fetchInventory(clientFor(mock, etags));
    mock.userRepos = [...mock.userRepos, 300];
    const result = await fetchInventory(clientFor(mock, etags));
    expect(result.repos.some((r) => r.id === apiRepo(300).id)).toBe(true);
  });

  it('finds a repository added after an exactly full last page, although that page answers 304 without a Link header', async () => {
    const mock = new MockGitHub({ userRepos: Array.from({ length: 200 }, (_, i) => i + 1) });
    const etags = new Map<string, CachedPage<unknown>>();
    expect((await fetchInventory(clientFor(mock, etags))).repos).toHaveLength(200);
    mock.userRepos = [...mock.userRepos, 201]; // sorted by creation: lands on a new third page
    mock.log = [];
    const result = await fetchInventory(clientFor(mock, etags));
    expect(result.repos.map((r) => r.id)).toContain(apiRepo(201).id);
    expect(mock.log.filter((r) => r.path === '/user/repos').map((r) => new URLSearchParams(r.query).get('page') ?? '1')).toEqual(['1', '2', '2', '3']);
  });

  it('fails the whole refresh on a transient error mid-pagination (caller keeps the previous cache)', async () => {
    const mock = releaseFixture();
    mock.failure = { kind: 'server-error', onPath: '/user/repos', afterPage: 2 };
    await expect(fetchInventory(clientFor(mock))).rejects.toMatchObject({ kind: 'http', status: 502 });
  });

  it('reports an inaccessible installation without failing the refresh', async () => {
    const mock = releaseFixture();
    mock.installations.push({ id: 73, account: 'sso-org', type: 'Organization', selection: 'all', repos: [1], failWith: 403 });
    const result = await fetchInventory(clientFor(mock));
    expect(result.installationIssues).toEqual([{ installation: expect.objectContaining({ account: 'sso-org' }), kind: 'forbidden' }]);
    expect(result.repos).toHaveLength(255);
  });

  it('skips suspended installations and keeps installation settings links on github.com only', async () => {
    const mock = releaseFixture();
    mock.installations.push({ id: 74, account: 'paused-org', type: 'Organization', selection: 'selected', repos: [1], suspended: true });
    const result = await fetchInventory(clientFor(mock));
    expect(result.installationIssues).toEqual([{ installation: expect.objectContaining({ account: 'paused-org', suspended: true }), kind: 'suspended' }]);
    expect(mock.log.some((r) => r.path === '/user/installations/74/repositories')).toBe(false);
    expect(result.installations.find((i) => i.account === 'acme-corp')!.settingsUrl).toBe('https://github.com/organizations/acme-corp/settings/installations/72');
  });

  it('refuses pagination links to other hosts so the token never leaves api.github.com', async () => {
    const mock = releaseFixture();
    mock.linkMode = 'foreign-host';
    await expect(fetchInventory(clientFor(mock))).rejects.toMatchObject({ kind: 'pagination' });
    expect(mock.log.every((r) => r.path.startsWith('/user'))).toBe(true);
  });

  it('stops on pagination loops', async () => {
    const mock = releaseFixture();
    mock.linkMode = 'loop';
    await expect(fetchInventory(clientFor(mock))).rejects.toMatchObject({ kind: 'pagination' });
  });

  it('classifies 401 as unauthorized and rate limits with their reset time', async () => {
    const mock = releaseFixture();
    mock.failure = { kind: 'unauthorized' };
    await expect(fetchInventory(clientFor(mock))).rejects.toMatchObject({ kind: 'unauthorized' });
    mock.failure = { kind: 'rate-limit', resetEpochSeconds: 2_000 };
    await expect(fetchInventory(clientFor(mock))).rejects.toMatchObject({ kind: 'rate-limited', resetAt: 2_000_000 });
    mock.failure = { kind: 'secondary', retryAfter: 30 };
    await expect(fetchInventory(clientFor(mock))).rejects.toMatchObject({ kind: 'rate-limited', resetAt: 1_000_000 + 30_000 });
  });

  it('treats network failures as offline and never leaks the token in errors', async () => {
    const client = new GitHubClient({
      apiBase: bases.apiBase,
      token: 'ghu_SECRET_TOKEN_VALUE',
      fetch: () => Promise.reject(new TypeError('Failed to fetch ghu_SECRET_TOKEN_VALUE')),
      etags: new Map(),
    });
    const error = await fetchInventory(client).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).kind).toBe('offline');
    expect(JSON.stringify(error) + String(error) + (error as Error).message).not.toContain('ghu_SECRET');
  });
});

describe('header parsing', () => {
  it('parses Link headers', () => {
    expect(parseLinkHeader('<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=3>; rel="last"')).toEqual({
      next: 'https://api.github.com/user/repos?page=2',
      last: 'https://api.github.com/user/repos?page=3',
    });
    expect(parseLinkHeader(null)).toEqual({});
  });

  it('distinguishes rate limits from plain 403s', () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(rateLimitResetAt(403, h({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '100' }), '', 0)).toBe(100_000);
    expect(rateLimitResetAt(429, h({}), '', 0)).toBe(60_000);
    expect(rateLimitResetAt(403, h({}), 'Resource protected by SAML', 0)).toBeNull();
    expect(rateLimitResetAt(500, h({ 'retry-after': '5' }), '', 0)).toBeNull();
  });
});
