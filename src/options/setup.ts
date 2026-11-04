import type { Diagnostics } from '../shared/messages';
import { CLIENT_ID_RE, type InstallationSummary } from '../shared/types';

/**
 * Guided setup: everything the Options page needs to walk someone from "no GitHub App" to "every repository
 * visible", with each step checked against real state rather than trusted to the user.
 */

export const NEW_APP_URL = 'https://github.com/settings/apps/new';
/** Where someone finds a GitHub App they already created (personal account, or an organization's). */
export const MY_APPS_URL = 'https://github.com/settings/apps';
export const orgAppsUrl = (org: string): string => `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps`;
/** Public homepage (pre-filled as the GitHub App's homepage). */
export const PROJECT_URL = 'https://levac.net/repo-navigator/';

/** What GitHub's new-app form is opened with: who owns the app, and its name. */
export interface AppForm {
  owner: 'user' | 'org';
  org: string;
  name: string;
}

/**
 * Adding another GitHub account: which GitHub App it connects through. Its own form, so making a second app never
 * overwrites the first app's name (which GitHub already has taken).
 */
export interface AddAccount {
  /** Accounts (user IDs) connected when it started: the first one beyond these is the one added. */
  had: number[];
  /** The account a GitHub page asked to connect ("Connect @login too"), or '' when not known. */
  login: string;
  /** The chosen app's client ID ('' until chosen). */
  clientId: string;
  /** Making (or pasting) a separate app for this account rather than reusing one. */
  separate: boolean;
  form: AppForm;
}

/** Remembered in the Options page's localStorage (per device), so a reload or a trip to GitHub loses nothing. */
export interface Wizard extends AppForm {
  /** Before 1.4: the one app's slug, confirmed or typed in. Still tried for any app; its client ID decides. */
  slug: string;
  /** Each app's slug, by client ID, once confirmed against GitHub (its client ID matched). */
  slugs: Record<string, string>;
  /** Accounts (user IDs) whose guide was finished or skipped; it stays hidden while their setup still works. */
  hidden: number[];
  /** Hidden by a version before 1.4, whose one switch meant the account connected then: the first one. */
  hiddenLegacy: boolean;
  /** First step: create a new GitHub App, or reuse the one already set up in another browser (null: not chosen). */
  path: 'new' | 'existing' | null;
  /** Adding another account (null: not). */
  add: AddAccount | null;
}

export const WIZARD_KEY = 'grn.setupWizard';
export const ORG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,99})$/;

/** GitHub App names are unique across all of GitHub, so a suggested name carries a random suffix. */
export function suggestedAppName(random: () => number = Math.random): string {
  return `Repo Navigator ${random().toString(36).slice(2, 7)}`;
}

export function defaultWizard(random: () => number = Math.random): Wizard {
  return { owner: 'user', org: '', name: suggestedAppName(random), slug: '', slugs: {}, hidden: [], hiddenLegacy: false, path: null, add: null };
}

/** Starts adding an account; `login` when a GitHub page asked for that one. */
export function startAdd(had: number[], login = '', random: () => number = Math.random): AddAccount {
  return { had, login, clientId: '', separate: false, form: { owner: 'user', org: '', name: suggestedAppName(random) } };
}

const ids = (value: unknown): number[] => (Array.isArray(value) ? value.filter((x): x is number => typeof x === 'number' && Number.isSafeInteger(x)) : []);

function parseForm(value: unknown, fallbackName: string): AppForm {
  const form = (value && typeof value === 'object' ? value : {}) as Partial<AppForm>;
  return {
    owner: form.owner === 'org' ? 'org' : 'user',
    org: typeof form.org === 'string' ? form.org : '',
    name: typeof form.name === 'string' && form.name.trim() ? form.name : fallbackName,
  };
}

function parseAdd(value: unknown, random: () => number): AddAccount | null {
  if (!value || typeof value !== 'object') return null;
  const add = value as Partial<AddAccount>;
  return {
    had: ids(add.had),
    login: typeof add.login === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(add.login) ? add.login : '',
    clientId: typeof add.clientId === 'string' && CLIENT_ID_RE.test(add.clientId) ? add.clientId : '',
    separate: add.separate === true,
    form: parseForm(add.form, suggestedAppName(random)),
  };
}

export function parseWizard(raw: string | null, fallback: Wizard = defaultWizard(), random: () => number = Math.random): Wizard {
  try {
    const saved = JSON.parse(raw ?? 'null') as (Partial<Wizard> & { dismissed?: unknown }) | null;
    if (!saved || typeof saved !== 'object') return fallback;
    const slugs = Object.fromEntries(
      Object.entries(saved.slugs && typeof saved.slugs === 'object' ? saved.slugs : {}).filter(([clientId, slug]) => CLIENT_ID_RE.test(clientId) && typeof slug === 'string' && SLUG_RE.test(slug)),
    );
    return {
      ...parseForm(saved, fallback.name),
      slug: typeof saved.slug === 'string' && SLUG_RE.test(saved.slug) ? saved.slug : '',
      slugs,
      hidden: ids(saved.hidden),
      hiddenLegacy: saved.hiddenLegacy === true || saved.dismissed === true,
      path: saved.path === 'new' || saved.path === 'existing' ? saved.path : null,
      add: parseAdd(saved.add, random),
    };
  } catch {
    return fallback;
  }
}

/**
 * A managed account (GitHub Enterprise Managed Users): its login is the person's name, an underscore and the
 * enterprise's short code, like mona-lisa_acme. Ordinary GitHub logins cannot contain an underscore.
 */
export function isManagedLogin(login: string | null | undefined): boolean {
  return !!login && /^[A-Za-z0-9-]+_[A-Za-z0-9]+$/.test(login);
}

/** A managed account's enterprise short code ("acme" for mona-lisa_acme). */
export function enterpriseCode(login: string): string {
  return login.slice(login.lastIndexOf('_') + 1);
}

/** GitHub's slug for an app name: lowercase, every run of other characters becomes one hyphen. */
export function slugFor(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Accepts what a person is likely to paste for "your app's address": the public page
 * (github.com/apps/<slug>), the settings page (github.com/settings/apps/<slug>, also under
 * /organizations/<org>/), or the bare slug.
 */
export function parseAppSlug(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  if (SLUG_RE.test(value.toLowerCase()) && !value.includes('/')) return value.toLowerCase();
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const at = parts.indexOf('apps');
  const slug = at >= 0 ? parts[at + 1]?.toLowerCase() : undefined;
  return slug && slug !== 'new' && slug !== 'authorizations' && SLUG_RE.test(slug) ? slug : null;
}

/** The GitHub App's description, shown to people when they install it. */
export const APP_DESCRIPTION = 'Read-only repository metadata for the Repo Navigator Chrome extension, which lists every repository you can access in GitHub’s navigation menu.';

/** One field of GitHub's new GitHub App form and what this extension needs in it. */
export interface AppFormField {
  /** Stable key, for tests and for updating a shown value in place. */
  id: string;
  /** The form's own label, so people can find it on GitHub's page. */
  label: string;
  /** What to type or choose. */
  value: string;
  /** Text to put in the field, shown with a Copy button. */
  copy?: string;
  /** GitHub cannot pre-fill this one, so the person always has to change it. */
  mustChange?: boolean;
}

/**
 * Every field on GitHub's new GitHub App form, top to bottom, and what goes in it. The pre-filled form only needs
 * Enable Device Flow ticked, but GitHub can open the form empty (or someone opens it by hand), so the setup page
 * lists every field rather than trusting the pre-fill.
 * https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app
 */
export function appFormFields(w: AppForm, managed = false): AppFormField[] {
  return [
    { id: 'name', label: 'GitHub App name', value: 'Required. Any name nobody else on GitHub uses; this one has a random ending for that reason.', copy: w.name.trim() },
    { id: 'description', label: 'Description', value: 'Optional. Leave it empty or write anything; people see it when they install the app.' },
    { id: 'homepage', label: 'Homepage URL', value: 'Required. This extension’s page, or any web address you own.', copy: PROJECT_URL },
    { id: 'callback', label: 'Callback URL', value: 'Leave it empty. Device Flow sign-in never redirects back, so nothing goes here.' },
    { id: 'expire', label: 'Expire user authorization tokens', value: 'Leave it checked. The extension renews its sign-in by itself.' },
    { id: 'oauth', label: 'Request user authorization (OAuth) during installation', value: 'Leave it unchecked.' },
    { id: 'device-flow', label: 'Enable Device Flow', value: 'Check it. This is how the extension signs in, and the one box GitHub does not let us tick for you.', mustChange: true },
    { id: 'setup-url', label: 'Setup URL', value: 'Leave it empty, and leave Redirect on update unchecked.' },
    { id: 'webhook', label: 'Webhook → Active', value: 'Uncheck it. Webhook URL and Secret then disappear: there is no server to send events to.' },
    { id: 'permissions', label: 'Permissions → Repository permissions → Metadata', value: 'Read-only. Leave every other repository, organization and account permission at No access.' },
    { id: 'events', label: 'Subscribe to events', value: 'Leave every box unchecked.' },
    managed
      ? { id: 'where', label: 'Where can this GitHub App be installed?', value: 'This enterprise. For a managed account it is the only choice GitHub offers, and it lets the app go on the enterprise’s organizations.' }
      : { id: 'where', label: 'Where can this GitHub App be installed?', value: 'Any account, so it can also be installed on organizations you belong to. This does not share your data with anyone.' },
  ];
}

/**
 * GitHub's "register an app with URL parameters" form, pre-filled with everything GitHub lets a URL set.
 * Device Flow is the one required setting it cannot pre-fill.
 * https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-using-url-parameters
 */
export function newAppUrl(w: AppForm): string {
  const base = w.owner === 'org' ? `https://github.com/organizations/${encodeURIComponent(w.org.trim())}/settings/apps/new` : NEW_APP_URL;
  const url = new URL(base);
  url.searchParams.set('name', w.name.trim());
  url.searchParams.set('description', APP_DESCRIPTION);
  url.searchParams.set('url', PROJECT_URL);
  url.searchParams.set('public', 'true');
  url.searchParams.set('request_oauth_on_install', 'false');
  url.searchParams.set('webhook_active', 'false');
  url.searchParams.set('metadata', 'read');
  return url.toString();
}

/** Where the app's owner manages it (Device Flow checkbox, client ID). */
export function appSettingsUrl(w: AppForm, slug: string): string {
  const base = w.owner === 'org' && ORG_RE.test(w.org.trim()) ? `https://github.com/organizations/${encodeURIComponent(w.org.trim())}/settings/apps` : 'https://github.com/settings/apps';
  return slug ? `${base}/${encodeURIComponent(slug)}` : base;
}

export function installUrl(slug: string): string {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}

/** Catches the common wrong pastes before the background's format check gives a generic error. */
export function clientIdProblem(value: string): string | null {
  if (/^Ov/.test(value)) return 'That client ID belongs to an OAuth App. This extension needs a GitHub App: use step 1 to create one (it opens the “GitHub Apps” form, not “OAuth Apps”).';
  if (/^[0-9a-f]{40}$/i.test(value)) return 'That looks like a client secret. Never paste a secret here. Copy the “Client ID” line near the top of the app’s page instead (it starts with “Iv”).';
  if (/\s/.test(value)) return 'The client ID has a space in it. Copy just the ID (it starts with “Iv”).';
  return null;
}

/**
 * Confirms a slug names the app whose client ID is configured, using GitHub's public (unauthenticated)
 * "get an app" endpoint, so install links are known to be right before anyone clicks them.
 */
export async function verifySlug(slug: string, clientId: string, apiBase: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!SLUG_RE.test(slug) || !clientId) return false;
  try {
    const response = await fetchImpl(`${apiBase}/apps/${encodeURIComponent(slug)}`, { headers: { Accept: 'application/vnd.github+json' }, credentials: 'omit' });
    if (!response.ok) return false;
    const body = (await response.json()) as { client_id?: unknown };
    return body.client_id === clientId;
  } catch {
    return false;
  }
}

export type SetupStep = 'create' | 'connect' | 'install' | 'done';

export interface SetupProgress {
  step: SetupStep;
  /** The installation on the signed-in user's own account, if any. */
  own: InstallationSummary | null;
  /** True while the first repository list after connecting is still loading. */
  checking: boolean;
}

/**
 * Where setup stands for the account the page shows, derived only from state the extension can verify:
 * no account and no client ID → create the app; not signed in → connect; app not installed on the user's own
 * account with All repositories → install; otherwise done. A managed account cannot have the app on itself
 * (GitHub does not allow it), so for one any installation it can see (an organization, or chosen repositories)
 * finishes setup.
 */
export function setupProgress(d: Diagnostics): SetupProgress {
  if (d.account === null && !d.clientId.value) return { step: 'create', own: null, checking: false };
  if (d.auth.kind !== 'signed-in') return { step: 'connect', own: null, checking: false };
  const login = d.auth.login?.toLowerCase() ?? null;
  const live = d.inventory.installations.filter((i) => !i.suspended);
  if (isManagedLogin(login)) {
    if (live.length) return { step: 'done', own: null, checking: false };
    return { step: 'install', own: null, checking: d.inventory.fetchedAt === null || d.inventory.status.kind === 'refreshing' };
  }
  const own = (login ? live.find((i) => i.account.toLowerCase() === login) : live[0]) ?? null;
  const checking = d.inventory.fetchedAt === null || (d.inventory.status.kind === 'refreshing' && !own);
  if (!own || own.repositorySelection !== 'all') return { step: 'install', own, checking };
  return { step: 'done', own, checking: false };
}
