import { describe, expect, it } from 'vitest';
import type { Diagnostics } from '../../src/shared/messages';
import type { InstallationSummary } from '../../src/shared/types';
import { appSettingsUrl, clientIdProblem, defaultWizard, installUrl, newAppUrl, parseAppSlug, parseWizard, setupProgress, slugFor, verifySlug } from '../../src/options/setup';

const install = (over: Partial<InstallationSummary> = {}): InstallationSummary => ({
  id: 71,
  account: 'JD2005L',
  accountType: 'User',
  repositorySelection: 'all',
  settingsUrl: 'https://github.com/settings/installations/71',
  suspended: false,
  ...over,
});

function diag(over: { clientId?: string; auth?: Diagnostics['auth']; installations?: InstallationSummary[]; fetchedAt?: number | null; refreshing?: boolean } = {}): Diagnostics {
  return {
    extensionVersion: '0.1.0',
    clientId: { value: over.clientId ?? 'Iv23liTest1234', source: 'options' },
    appSlug: '',
    accounts: over.auth && over.auth.kind !== 'signed-in' ? [] : [{ userId: 1001, login: 'jd2005l', kind: 'signed-in' }],
    account: over.auth && over.auth.kind !== 'signed-in' ? null : 1001,
    auth: over.auth ?? { kind: 'signed-in', login: 'jd2005l', expiresAt: null },
    connect: { kind: 'signed-out', clientIdConfigured: true, problem: null },
    inventory: {
      count: 9,
      fetchedAt: over.fetchedAt === undefined ? 1 : over.fetchedAt,
      pages: 1,
      notModifiedPages: 0,
      rejected: 0,
      installations: over.installations ?? [],
      installationIssues: [],
      ssoHiddenOrganizations: [],
      rateLimit: { limit: null, remaining: null, resetAt: null },
      status: over.refreshing ? { kind: 'refreshing' } : { kind: 'idle' },
    },
    layout: { sections: 1, assigned: 0, unavailable: 0, sync: { kind: 'ok', bytes: 0, chunks: 0, lastWriteAt: null, pending: false }, editable: true, syncBytesInUse: 0 },
    startChoice: false,
  };
}

describe('setupProgress', () => {
  it('starts at creating the app when there is no client ID', () => {
    expect(setupProgress(diag({ clientId: '' })).step).toBe('create');
  });

  it('asks to connect until signed in (signed out, mid code entry, or expired)', () => {
    expect(setupProgress(diag({ auth: { kind: 'signed-out', clientIdConfigured: true, problem: null } })).step).toBe('connect');
    expect(setupProgress(diag({ auth: { kind: 'authorizing', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', expiresAt: 1 } })).step).toBe('connect');
    expect(setupProgress(diag({ auth: { kind: 'expired', login: 'jd2005l' } })).step).toBe('connect');
  });

  it('holds at install while connected without an installation: the "only public repositories" case', () => {
    const p = setupProgress(diag());
    expect(p).toMatchObject({ step: 'install', own: null, checking: false });
  });

  it('reports checking until the first list after connecting arrives', () => {
    expect(setupProgress(diag({ fetchedAt: null })).checking).toBe(true);
  });

  it('holds at install when the own installation only shares selected repositories', () => {
    const p = setupProgress(diag({ installations: [install({ repositorySelection: 'selected' })] }));
    expect(p.step).toBe('install');
    expect(p.own?.account).toBe('JD2005L');
  });

  it('is not satisfied by an organization installation alone, or a suspended own one', () => {
    expect(setupProgress(diag({ installations: [install({ account: 'some-org', accountType: 'Organization' })] })).step).toBe('install');
    expect(setupProgress(diag({ installations: [install({ suspended: true })] })).step).toBe('install');
  });

  it('is done once the own account (matched case-insensitively) shares all repositories', () => {
    expect(setupProgress(diag({ installations: [install()] })).step).toBe('done');
  });
});

describe('app addresses', () => {
  it('derives GitHub’s slug from an app name', () => {
    expect(slugFor('Repo Navigator 1n4co')).toBe('repo-navigator-1n4co');
    expect(slugFor('  Repo  Navigator (James)! ')).toBe('repo-navigator-james');
  });

  it('reads the slug from any app address a person is likely to paste', () => {
    expect(parseAppSlug('https://github.com/settings/apps/repo-navigator-1n4co')).toBe('repo-navigator-1n4co');
    expect(parseAppSlug('github.com/apps/Repo-Navigator-1n4co/installations/new')).toBe('repo-navigator-1n4co');
    expect(parseAppSlug('https://github.com/organizations/acme/settings/apps/acme-nav')).toBe('acme-nav');
    expect(parseAppSlug('repo-navigator-1n4co')).toBe('repo-navigator-1n4co');
    expect(parseAppSlug('https://github.com/settings/apps/new')).toBeNull();
    expect(parseAppSlug('https://evil.example/apps/x')).toBeNull();
    expect(parseAppSlug('')).toBeNull();
  });

  it('pre-fills the new-app form with everything the URL can set, for a user or an organization', () => {
    const w = { ...defaultWizard(() => 0.5), name: 'Repo Navigator x' };
    const user = new URL(newAppUrl(w));
    expect(user.origin + user.pathname).toBe('https://github.com/settings/apps/new');
    expect(Object.fromEntries(user.searchParams)).toMatchObject({ name: 'Repo Navigator x', public: 'true', webhook_active: 'false', request_oauth_on_install: 'false', metadata: 'read' });
    const org = new URL(newAppUrl({ ...w, owner: 'org', org: ' acme ' }));
    expect(org.pathname).toBe('/organizations/acme/settings/apps/new');
  });

  it('links to the app settings and install pages', () => {
    const w = defaultWizard();
    expect(appSettingsUrl(w, 'nav')).toBe('https://github.com/settings/apps/nav');
    expect(appSettingsUrl({ ...w, owner: 'org', org: 'acme' }, '')).toBe('https://github.com/organizations/acme/settings/apps');
    expect(installUrl('nav')).toBe('https://github.com/apps/nav/installations/new');
  });
});

describe('verifySlug', () => {
  const fetchReturning = (status: number, body: unknown) => (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;

  it('accepts a slug only when GitHub says it has the configured client ID', async () => {
    expect(await verifySlug('nav', 'Iv23liA', 'https://api.github.com', fetchReturning(200, { client_id: 'Iv23liA' }))).toBe(true);
    expect(await verifySlug('nav', 'Iv23liA', 'https://api.github.com', fetchReturning(200, { client_id: 'Iv23liB' }))).toBe(false);
    expect(await verifySlug('nav', 'Iv23liA', 'https://api.github.com', fetchReturning(404, { message: 'Not Found' }))).toBe(false);
    expect(await verifySlug('bad slug', 'Iv23liA', 'https://api.github.com', fetchReturning(200, { client_id: 'Iv23liA' }))).toBe(false);
  });

  it('treats a network failure as unverified', async () => {
    const failing = (() => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch;
    expect(await verifySlug('nav', 'Iv23liA', 'https://api.github.com', failing)).toBe(false);
  });
});

describe('wizard state and client ID checks', () => {
  it('restores saved state and falls back safely on junk', () => {
    const fallback = defaultWizard(() => 0.5);
    expect(parseWizard('{"owner":"org","org":"acme","name":"N","slug":"n","dismissed":true,"path":"existing"}', fallback)).toEqual({ owner: 'org', org: 'acme', name: 'N', slug: 'n', dismissed: true, path: 'existing' });
    expect(parseWizard('{"owner":"x","slug":"Bad Slug","path":"sideways"}', fallback)).toEqual({ ...fallback, slug: '', path: null });
    expect(parseWizard('not json', fallback)).toEqual(fallback);
    expect(parseWizard(null, fallback)).toEqual(fallback);
  });

  it('explains the common wrong pastes', () => {
    expect(clientIdProblem('Ov23liAbc')).toMatch(/OAuth App/);
    expect(clientIdProblem('0123456789abcdef0123456789abcdef01234567')).toMatch(/client secret/);
    expect(clientIdProblem('Iv23li abc')).toMatch(/space/);
    expect(clientIdProblem('Iv23liAbc123')).toBeNull();
  });
});
