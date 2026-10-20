import type { RepoHint, RepoId, RepoRecord } from '../types';

/**
 * Suggests sections for repositories that are still uncategorized. Pure and deterministic: the same input
 * always gives the same suggestion, so it is easy to test and to explain.
 *
 * Signals, strongest first (a repository goes to the first rule that claims it):
 *   1. archived                       → "Archive" (collapsed)
 *   2. owned by another account       → a section named after that account
 *   3. a shared name prefix (3+ repos) → a section named after the prefix, e.g. AcmeAuth, AcmeBilling…
 *   4. keywords in the name, description, topics and language → a few broad categories
 *   5. forks nobody else claimed      → "Forks"
 * Anything left stays in Uncategorized; a guess is never forced.
 */

export interface SuggestedSection {
  /** Stable within one suggestion, used by the preview to track edits. */
  key: string;
  name: string;
  collapsed: boolean;
  repoIds: RepoId[];
  /** Short human explanation shown in the preview. */
  why: string;
}

interface Category {
  name: string;
  why: string;
  match: (text: string, repo: RepoRecord, hint: RepoHint | undefined) => boolean;
}

const WEB_LANGUAGES = new Set(['html', 'css', 'scss', 'php', 'astro', 'vue', 'svelte']);

const words = (pattern: string) => new RegExp(`\\b(?:${pattern})\\b`);

const CATEGORIES: Category[] = [
  {
    name: 'Websites',
    why: 'website names, descriptions or web languages',
    match: (text, repo, hint) =>
      /public$/i.test(repo.name) || words('website|websites|web ?site|landing ?page|homepage|static ?site|wordpress|squarespace|blog').test(text) || WEB_LANGUAGES.has((hint?.language ?? '').toLowerCase()),
  },
  {
    name: 'AI & agents',
    why: 'AI, agent, LLM or Claude keywords',
    match: (text) => words('ai|agent|agents|agentic|llm|llms|gpt|chatgpt|claude|openai|anthropic|gemini|mcp|copilot|chatbot|prompt|prompts|rag|openclaw|ollama|(?<!home )assistant').test(text),
  },
  {
    name: 'Homelab & infrastructure',
    why: 'homelab, server, media or automation keywords',
    match: (text) =>
      words(
        'homelab|home ?lab|proxmox|pve|docker|kubernetes|k8s|nas|truenas|unraid|plex|jellyfin|emby|sonarr|radarr|seerr|media|backup|backups|home ?assistant|esp ?32|esp ?8266|iot|raspberry|arduino|pihole|pi ?hole|network|dns|n8n|automation|selfhosted|self ?hosted|server|nvr|camera|cameras|blue ?iris|stream|streaming|video|firewall|opnsense|vpn',
      ).test(text),
  },
  {
    name: 'Tools & utilities',
    why: 'tool, extension, editor or script keywords',
    match: (text) => words('tool|tools|tooling|cli|extension|plugin|plugins|editor|monitor|script|scripts|utility|utilities|dotfiles|config|configs|template|templates|generator|sdk|library').test(text),
  },
  {
    name: 'Apps & portals',
    why: 'app, portal, management or tracker keywords',
    match: (text) => words('app|apps|application|portal|portals|management|manager|crm|erp|booking|dashboard|tracker|ledger|inventory|invoicing|scheduling|system').test(text),
  },
];

/** Splits a repository name into words: dashes, underscores, dots, camelCase and ACRONYMWords. */
export function nameTokens(name: string): string[] {
  return name.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+/g) ?? [];
}

function searchText(repo: RepoRecord, hint: RepoHint | undefined): string {
  return [nameTokens(repo.name).join(' '), hint?.description ?? '', ...(hint?.topics ?? []).map((t) => t.replace(/-/g, ' ')), hint?.language ?? ''].join(' ').toLowerCase();
}

/** Prefix families: the first one or two name words shared by 3+ repositories ("ACME", "Big Data", "claude"). */
function families(repos: RepoRecord[]): { prefix: string; label: string; ids: RepoId[] }[] {
  const groups = new Map<string, { label: string; ids: RepoId[] }>();
  for (const repo of repos) {
    const tokens = nameTokens(repo.name);
    for (const k of [1, 2]) {
      if (tokens.length <= k) continue; // the whole name is not a family prefix
      const parts = tokens.slice(0, k);
      const label = parts.join('');
      const acronym = k === 1 && /^[A-Z]{2,}$/.test(parts[0]!);
      // Short common words ("Pro", "My", "The") make meaningless families; acronyms like "ACME" do not.
      if (!acronym && label.length < 4) continue;
      const key = label.toLowerCase();
      const group = groups.get(key) ?? { label, ids: [] };
      group.ids.push(repo.id);
      groups.set(key, group);
    }
  }
  return [...groups.entries()]
    .filter(([, g]) => g.ids.length >= 3)
    .map(([prefix, g]) => ({ prefix, label: g.label, ids: g.ids }))
    .sort((a, b) => b.ids.length - a.ids.length || b.prefix.length - a.prefix.length || a.prefix.localeCompare(b.prefix));
}

function title(label: string): string {
  return label === label.toLowerCase() ? label.charAt(0).toUpperCase() + label.slice(1) : label;
}

export function suggestSections(input: { repos: RepoRecord[]; hints: ReadonlyMap<RepoId, RepoHint>; login: string | null }): SuggestedSection[] {
  const repos = [...input.repos].sort((a, b) => `${a.owner}/${a.name}`.toLowerCase().localeCompare(`${b.owner}/${b.name}`.toLowerCase()));
  const remaining = new Map(repos.map((r) => [r.id, r]));
  const out: SuggestedSection[] = [];
  const take = (key: string, name: string, why: string, ids: RepoId[], collapsed = false) => {
    const claimed = ids.filter((id) => remaining.delete(id));
    if (claimed.length) out.push({ key, name, collapsed, repoIds: claimed, why });
  };

  take('archive', 'Archive', 'archived on GitHub', repos.filter((r) => r.archived).map((r) => r.id), true);

  const login = input.login?.toLowerCase() ?? null;
  if (login) {
    const byOwner = new Map<string, RepoRecord[]>();
    for (const repo of remaining.values()) if (repo.owner.toLowerCase() !== login) byOwner.set(repo.owner, [...(byOwner.get(repo.owner) ?? []), repo]);
    for (const [owner, owned] of [...byOwner.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
      take(`owner:${owner.toLowerCase()}`, owner, `owned by ${owner}`, owned.map((r) => r.id));
    }
  }

  // Largest families first; a smaller family keeps only what a larger one did not already take, and is dropped
  // if that leaves fewer than three.
  for (const family of families([...remaining.values()])) {
    const free = family.ids.filter((id) => remaining.has(id));
    if (free.length >= 3) take(`family:${family.prefix}`, title(family.label), `names start with “${family.label}”`, free);
  }

  for (const category of CATEGORIES) {
    const ids = [...remaining.values()].filter((repo) => category.match(searchText(repo, input.hints.get(repo.id)), repo, input.hints.get(repo.id))).map((r) => r.id);
    take(`category:${category.name.toLowerCase()}`, category.name, category.why, ids);
  }

  take('forks', 'Forks', 'forks of other projects', [...remaining.values()].filter((r) => r.fork).map((r) => r.id));
  // Archive claims its repositories first but belongs at the bottom of the list.
  return [...out.filter((s) => s.key !== 'archive'), ...out.filter((s) => s.key === 'archive')];
}
