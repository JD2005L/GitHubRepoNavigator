import type { InstallationSummary, RepoId, RepoRecord } from '../../shared/types';
import { compareRepos } from '../../shared/layout/model';
import { GitHubError, collectAllPages, type GitHubClient } from './client';

/** GitHub logins: alphanumerics and hyphens (plus `_` for enterprise managed users). */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,99})$/;
/** Repository names: ASCII letters, digits, `.`, `-`, `_`. */
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const AVATAR_PREFIX = 'https://avatars.githubusercontent.com/';

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeAvatar(url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith(AVATAR_PREFIX)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://avatars.githubusercontent.com') return null;
    parsed.searchParams.set('s', '40');
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Reduces a REST repository object to the navigation metadata we keep. Anything that does not look like a
 * real GitHub owner/name is rejected so it can never reach a link or the DOM.
 */
export function normalizeRepo(raw: unknown): RepoRecord | null {
  if (!isObject(raw) || !isObject(raw.owner)) return null;
  const id = raw.id;
  const owner = raw.owner.login;
  const name = raw.name;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof owner !== 'string' || !OWNER_RE.test(owner)) return null;
  if (typeof name !== 'string' || !NAME_RE.test(name) || name === '.' || name === '..') return null;
  const isPrivate = raw.private === true;
  const visibility = raw.visibility === 'internal' ? 'internal' : raw.visibility === 'private' || isPrivate ? 'private' : 'public';
  return {
    id,
    nodeId: typeof raw.node_id === 'string' ? raw.node_id.slice(0, 64) : '',
    owner,
    name,
    ownerAvatarUrl: safeAvatar(raw.owner.avatar_url),
    private: isPrivate || visibility !== 'public',
    visibility,
    archived: raw.archived === true,
    fork: raw.fork === true,
    pushedAt: typeof raw.pushed_at === 'string' ? raw.pushed_at.slice(0, 40) : null,
  };
}

function normalizeInstallation(raw: unknown): InstallationSummary | null {
  if (!isObject(raw) || typeof raw.id !== 'number' || !Number.isSafeInteger(raw.id) || raw.id <= 0) return null;
  const account = isObject(raw.account) ? raw.account : {};
  const login = typeof account.login === 'string' && OWNER_RE.test(account.login) ? account.login : typeof account.slug === 'string' && OWNER_RE.test(account.slug) ? account.slug : '(unknown)';
  let settingsUrl: string | null = null;
  if (typeof raw.html_url === 'string') {
    try {
      const url = new URL(raw.html_url);
      if (url.protocol === 'https:' && url.hostname === 'github.com') settingsUrl = url.toString();
    } catch {
      settingsUrl = null;
    }
  }
  return {
    id: raw.id,
    account: login,
    accountType: typeof account.type === 'string' ? account.type.slice(0, 32) : typeof raw.target_type === 'string' ? raw.target_type.slice(0, 32) : 'Account',
    repositorySelection: typeof raw.repository_selection === 'string' ? raw.repository_selection.slice(0, 16) : 'unknown',
    settingsUrl,
    suspended: raw.suspended_at !== null && raw.suspended_at !== undefined,
  };
}

// Pages are normalized before they are returned (and before the client caches them for ETag reuse), so raw
// API objects (descriptions, topics, permissions) never reach storage.
function userRepos(json: unknown): (RepoRecord | null)[] {
  if (!Array.isArray(json)) throw new GitHubError('invalid-response', 'GitHub returned an unexpected repository list.');
  return json.map(normalizeRepo);
}

function field(json: unknown, name: 'installations' | 'repositories'): unknown[] {
  if (!isObject(json) || !Array.isArray(json[name])) throw new GitHubError('invalid-response', `GitHub returned an unexpected ${name} list.`);
  return json[name];
}

const installationRepos = (json: unknown): (RepoRecord | null)[] => field(json, 'repositories').map(normalizeRepo);
export const installationsPage = (json: unknown): (InstallationSummary | null)[] => field(json, 'installations').map(normalizeInstallation);

export const USER_REPOS_PATH = '/user/repos?per_page=100&affiliation=owner%2Ccollaborator%2Corganization_member&visibility=all&sort=created&direction=asc';
export const INSTALLATIONS_PATH = '/user/installations?per_page=100';
export const installationReposPath = (id: number) => `/user/installations/${id}/repositories?per_page=100`;

export interface InstallationIssue {
  installation: InstallationSummary;
  kind: 'forbidden' | 'not-found' | 'suspended';
}

export interface InventoryResult {
  repos: RepoRecord[];
  installations: InstallationSummary[];
  installationIssues: InstallationIssue[];
  pages: number;
  rejected: number;
}

/**
 * Builds the complete inventory: every page of `/user/repos` plus every page of every installation the user
 * can reach, deduplicated by immutable repository ID. Requests run one at a time (GitHub's guidance for
 * avoiding secondary rate limits). Any transient failure throws so the caller keeps the previous cache; an
 * installation that is persistently forbidden/not found (e.g. SAML session missing) is reported, not fatal.
 */
export async function fetchInventory(client: GitHubClient): Promise<InventoryResult> {
  const byId = new Map<RepoId, RepoRecord>();
  let rejected = 0;
  let pages = 0;
  const add = (repo: RepoRecord | null) => {
    if (!repo) {
      rejected++;
      return;
    }
    byId.set(repo.id, repo); // same ID from another endpoint: identical repository, latest metadata wins
  };

  const owned = await collectAllPages(client, client.url(USER_REPOS_PATH), userRepos);
  pages += owned.pages;
  owned.items.forEach(add);

  const listed = await collectAllPages(client, client.url(INSTALLATIONS_PATH), installationsPage);
  pages += listed.pages;
  const installations: InstallationSummary[] = [];
  const seenInstallations = new Set<number>();
  for (const installation of listed.items) {
    if (installation && !seenInstallations.has(installation.id)) {
      seenInstallations.add(installation.id);
      installations.push(installation);
    }
  }

  const installationIssues: InstallationIssue[] = [];
  for (const installation of installations) {
    if (installation.suspended) {
      installationIssues.push({ installation, kind: 'suspended' });
      continue;
    }
    try {
      const result = await collectAllPages(client, client.url(installationReposPath(installation.id)), installationRepos);
      pages += result.pages;
      result.items.forEach(add);
    } catch (error) {
      if (error instanceof GitHubError && (error.kind === 'forbidden' || error.kind === 'not-found')) {
        installationIssues.push({ installation, kind: error.kind });
        continue;
      }
      throw error;
    }
  }

  return { repos: [...byId.values()].sort(compareRepos), installations, installationIssues, pages, rejected };
}
