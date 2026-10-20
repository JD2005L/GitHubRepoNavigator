import type { Diagnostics } from '../shared/messages';
import type { InstallationSummary } from '../shared/types';

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

/** Remembered in the Options page's localStorage (per device), so a reload or a trip to GitHub loses nothing. */
export interface Wizard {
  owner: 'user' | 'org';
  org: string;
  name: string;
  /** The app's slug once confirmed against GitHub (its client ID matched), or typed in by the user. */
  slug: string;
  /** The user finished (or skipped) the guide; it stays hidden while setup still works. */
  dismissed: boolean;
  /** First step: create a new GitHub App, or reuse the one already set up in another browser (null: not chosen). */
  path: 'new' | 'existing' | null;
}

export const WIZARD_KEY = 'grn.setupWizard';
export const ORG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,99})$/;

export function defaultWizard(random: () => number = Math.random): Wizard {
  // GitHub App names are unique across all of GitHub, so the default carries a random suffix.
  return { owner: 'user', org: '', name: `Repo Navigator ${random().toString(36).slice(2, 7)}`, slug: '', dismissed: false, path: null };
}

export function parseWizard(raw: string | null, fallback: Wizard = defaultWizard()): Wizard {
  try {
    const saved = JSON.parse(raw ?? 'null') as Partial<Wizard> | null;
    if (!saved || typeof saved !== 'object') return fallback;
    return {
      owner: saved.owner === 'org' ? 'org' : 'user',
      org: typeof saved.org === 'string' ? saved.org : '',
      name: typeof saved.name === 'string' && saved.name.trim() ? saved.name : fallback.name,
      slug: typeof saved.slug === 'string' && SLUG_RE.test(saved.slug) ? saved.slug : '',
      dismissed: saved.dismissed === true,
      path: saved.path === 'new' || saved.path === 'existing' ? saved.path : null,
    };
  } catch {
    return fallback;
  }
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

/**
 * GitHub's "register an app with URL parameters" form, pre-filled with everything GitHub lets a URL set.
 * Device Flow is the one required setting it cannot pre-fill.
 * https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-using-url-parameters
 */
export function newAppUrl(w: Wizard): string {
  const base = w.owner === 'org' ? `https://github.com/organizations/${encodeURIComponent(w.org.trim())}/settings/apps/new` : NEW_APP_URL;
  const url = new URL(base);
  url.searchParams.set('name', w.name.trim());
  url.searchParams.set('description', 'Read-only repository metadata for the GitHub Repo Navigator Chrome extension, which lists every repository you can access in GitHub’s navigation menu.');
  url.searchParams.set('url', PROJECT_URL);
  url.searchParams.set('public', 'true');
  url.searchParams.set('request_oauth_on_install', 'false');
  url.searchParams.set('webhook_active', 'false');
  url.searchParams.set('metadata', 'read');
  return url.toString();
}

/** Where the app's owner manages it (Device Flow checkbox, client ID). */
export function appSettingsUrl(w: Wizard, slug: string): string {
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
 * Where setup stands, derived only from state the extension can verify:
 * no client ID → create the app; not signed in → connect; app not installed on the user's own account with
 * All repositories → install; otherwise done.
 */
export function setupProgress(d: Diagnostics): SetupProgress {
  if (!d.clientId.value) return { step: 'create', own: null, checking: false };
  if (d.auth.kind !== 'signed-in') return { step: 'connect', own: null, checking: false };
  const login = d.auth.login?.toLowerCase() ?? null;
  const live = d.inventory.installations.filter((i) => !i.suspended);
  const own = (login ? live.find((i) => i.account.toLowerCase() === login) : live[0]) ?? null;
  const checking = d.inventory.fetchedAt === null || (d.inventory.status.kind === 'refreshing' && !own);
  if (!own || own.repositorySelection !== 'all') return { step: 'install', own, checking };
  return { step: 'done', own, checking: false };
}
