import { describe, expect, it } from 'vitest';
import type { Diagnostics } from '../../src/shared/messages';
import type { InstallationSummary } from '../../src/shared/types';
import {
  APP_DESCRIPTION,
  appFormFields,
  appSettingsUrl,
  clientIdProblem,
  defaultWizard,
  enterpriseCode,
  installUrl,
  isManagedLogin,
  newAppUrl,
  parseAppSlug,
  parseWizard,
  setupProgress,
  slugFor,
  startAdd,
  verifySlug,
} from '../../src/options/setup';

const install = (over: Partial<InstallationSummary> = {}): InstallationSummary => ({
  id: 71,
  account: 'JD2005L',
  accountType: 'User',
  repositorySelection: 'all',
  settingsUrl: 'https://github.com/settings/installations/71',
  suspended: false,
  ...over,
});

function diag(over: { clientId?: string; login?: string; app?: string; auth?: Diagnostics['auth']; installations?: InstallationSummary[]; fetchedAt?: number | null; refreshing?: boolean } = {}): Diagnostics {
  return {
    extensionVersion: '0.1.0',
    clientId: { value: over.clientId ?? 'Iv23liTest1234', source: 'options' },
    appSlug: '',
    accounts: over.auth && over.auth.kind !== 'signed-in' ? [] : [{ userId: 1001, login: over.login ?? 'jd2005l', kind: 'signed-in', app: over.app ?? null }],
    ownApps: [],
    account: over.auth && over.auth.kind !== 'signed-in' ? null : 1001,
    auth: over.auth ?? { kind: 'signed-in', login: over.login ?? 'jd2005l', expiresAt: null },
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
  it('starts at creating the app when there is no client ID and no account', () => {
    expect(setupProgress(diag({ clientId: '', auth: { kind: 'signed-out', clientIdConfigured: false, problem: null } })).step).toBe('create');
  });

  it('needs no default app for an account that signs in through its own', () => {
    expect(setupProgress(diag({ clientId: '', app: 'Iv23liOwnApp0001', installations: [install()] })).step).toBe('done');
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

  it('never asks a managed account to install the app on itself: any installation it can see finishes setup', () => {
    const managed = { login: 'james-levac_goa' };
    expect(setupProgress(diag(managed))).toMatchObject({ step: 'install', own: null, checking: false });
    expect(setupProgress(diag({ ...managed, fetchedAt: null })).checking).toBe(true);
    expect(setupProgress(diag({ ...managed, installations: [install({ account: 'goa-org', accountType: 'Organization', repositorySelection: 'selected' })] })).step).toBe('done');
    expect(setupProgress(diag({ ...managed, installations: [install({ account: 'goa-org', accountType: 'Organization', suspended: true })] })).step).toBe('install');
  });
});

describe('managed accounts', () => {
  it('are recognized by the underscore and enterprise short code GitHub gives them', () => {
    expect(isManagedLogin('james-levac_goa')).toBe(true);
    expect(isManagedLogin('mona_ACME1')).toBe(true);
    expect(enterpriseCode('james-levac_goa')).toBe('goa');
    // Ordinary logins cannot contain an underscore.
    expect(isManagedLogin('JD2005L')).toBe(false);
    expect(isManagedLogin('jd-work')).toBe(false);
    expect(isManagedLogin('_goa')).toBe(false);
    expect(isManagedLogin(null)).toBe(false);
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

  it('lists every field of GitHub’s form with what goes in it, agreeing with the pre-filled link', () => {
    const w = { ...defaultWizard(() => 0.5), name: ' Repo Navigator x ' };
    const fields = appFormFields(w);
    expect(fields.map((f) => f.label)).toEqual([
      'GitHub App name',
      'Description',
      'Homepage URL',
      'Callback URL',
      'Expire user authorization tokens',
      'Request user authorization (OAuth) during installation',
      'Enable Device Flow',
      'Setup URL',
      'Webhook → Active',
      'Permissions → Repository permissions → Metadata',
      'Subscribe to events',
      'Where can this GitHub App be installed?',
    ]);
    expect(fields.every((f) => f.value.length > 0)).toBe(true);
    // Device Flow is the one setting the link cannot pre-fill, so it is the one marked as always needing a change.
    expect(fields.filter((f) => f.mustChange).map((f) => f.id)).toEqual(['device-flow']);
    // The values offered to copy are the ones the link pre-fills.
    const prefilled = new URL(newAppUrl(w)).searchParams;
    expect(fields.find((f) => f.id === 'name')?.copy).toBe(prefilled.get('name'));
    expect(fields.find((f) => f.id === 'homepage')?.copy).toBe(prefilled.get('url'));
    expect(prefilled.get('description')).toBe(APP_DESCRIPTION);
  });

  it('tells a managed account that its app can only be for its enterprise', () => {
    const where = (managed: boolean) => appFormFields(defaultWizard(() => 0.5), managed).find((f) => f.id === 'where')?.value;
    expect(where(true)).toMatch(/^This enterprise\./);
    expect(where(false)).toMatch(/^Any account/);
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
    const saved = {
      owner: 'org',
      org: 'acme',
      name: 'N',
      slug: 'n',
      slugs: { Iv23liAppOne0001: 'app-one', 'not a client id': 'x', Iv23liAppTwo0002: 'Bad Slug' },
      hidden: [1001, 'x'],
      path: 'existing',
      add: { had: [1001], login: 'james-levac_goa', clientId: 'Iv23liGoaApp0001', separate: true, form: { owner: 'user', org: '', name: 'Repo Navigator goa' } },
    };
    expect(parseWizard(JSON.stringify(saved), fallback)).toEqual({ ...saved, slugs: { Iv23liAppOne0001: 'app-one' }, hidden: [1001], hiddenLegacy: false });
    expect(parseWizard('{"owner":"x","slug":"Bad Slug","path":"sideways","add":{"login":"a b","clientId":"secret"}}', fallback, () => 0.5)).toEqual({
      ...fallback,
      slug: '',
      path: null,
      add: { had: [], login: '', clientId: '', separate: false, form: { owner: 'user', org: '', name: fallback.name } },
    });
    expect(parseWizard('not json', fallback)).toEqual(fallback);
    expect(parseWizard(null, fallback)).toEqual(fallback);
  });

  it('keeps an older version’s one "hide the guide" switch, to apply to the first account only', () => {
    expect(parseWizard('{"dismissed":true}', defaultWizard(() => 0.5))).toMatchObject({ hidden: [], hiddenLegacy: true });
  });

  it('gives an added account’s new app a fresh name, never the first app’s (GitHub already has that one)', () => {
    const first = defaultWizard(() => 0.25);
    const add = startAdd([1001], 'james-levac_goa', () => 0.75);
    expect(add).toMatchObject({ had: [1001], login: 'james-levac_goa', clientId: '', separate: false });
    expect(add.form.name).toMatch(/^Repo Navigator \w+$/);
    expect(add.form.name).not.toBe(first.name);
  });

  it('explains the common wrong pastes', () => {
    expect(clientIdProblem('Ov23liAbc')).toMatch(/OAuth App/);
    expect(clientIdProblem('0123456789abcdef0123456789abcdef01234567')).toMatch(/client secret/);
    expect(clientIdProblem('Iv23li abc')).toMatch(/space/);
    expect(clientIdProblem('Iv23liAbc123')).toBeNull();
  });
});
