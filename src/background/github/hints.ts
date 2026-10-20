import type { RepoHint, RepoId } from '../../shared/types';
import { GitHubError, collectAllPages, type GitHubClient } from './client';
import { INSTALLATIONS_PATH, USER_REPOS_PATH, installationReposPath, installationsPage } from './inventory';

/**
 * Extra metadata used only to suggest sections: description, primary language and topics. Fetched on request
 * from the Options page, returned to it, and dropped; never cached, stored or synced. The caller gives this a
 * client with its own empty ETag map, so it never reuses or overwrites the repository list's cached pages.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const clip = (value: unknown, max: number): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export function normalizeHint(raw: unknown): RepoHint | null {
  if (!isObject(raw) || typeof raw.id !== 'number' || !Number.isSafeInteger(raw.id) || raw.id <= 0) return null;
  const topics = Array.isArray(raw.topics) ? raw.topics.filter((t): t is string => typeof t === 'string').map((t) => clip(t, 50)).filter(Boolean).slice(0, 20) : [];
  return { id: raw.id, description: clip(raw.description, 300), language: clip(raw.language, 40), topics };
}

function hintsPage(json: unknown): (RepoHint | null)[] {
  if (!Array.isArray(json)) throw new GitHubError('invalid-response', 'GitHub returned an unexpected repository list.');
  return json.map(normalizeHint);
}

function installationHintsPage(json: unknown): (RepoHint | null)[] {
  if (!isObject(json) || !Array.isArray(json.repositories)) throw new GitHubError('invalid-response', 'GitHub returned an unexpected repositories list.');
  return json.repositories.map(normalizeHint);
}

/** Same endpoints as the inventory; an installation GitHub refuses is skipped (its repositories just get no hints). */
export async function fetchRepoHints(client: GitHubClient): Promise<Map<RepoId, RepoHint>> {
  const hints = new Map<RepoId, RepoHint>();
  const add = (items: (RepoHint | null)[]) => {
    for (const hint of items) if (hint) hints.set(hint.id, hint);
  };
  add((await collectAllPages(client, client.url(USER_REPOS_PATH), hintsPage)).items);
  const installations = await collectAllPages(client, client.url(INSTALLATIONS_PATH), installationsPage);
  for (const installation of installations.items) {
    if (!installation || installation.suspended) continue;
    try {
      add((await collectAllPages(client, client.url(installationReposPath(installation.id)), installationHintsPage)).items);
    } catch (error) {
      if (error instanceof GitHubError && (error.kind === 'forbidden' || error.kind === 'not-found')) continue;
      throw error;
    }
  }
  return hints;
}
