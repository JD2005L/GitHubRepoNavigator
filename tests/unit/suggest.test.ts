import { describe, expect, it } from 'vitest';
import { GitHubClient, type CachedPage } from '../../src/background/github/client';
import { fetchRepoHints, normalizeHint } from '../../src/background/github/hints';
import { fetchInventory } from '../../src/background/github/inventory';
import { nameTokens, suggestSections } from '../../src/shared/layout/suggest';
import type { RepoHint, RepoRecord } from '../../src/shared/types';
import { releaseFixture } from '../helpers/mockGithub';
import { apiRepo } from '../helpers/repos';

let nextId = 1;
function repo(name: string, over: Partial<RepoRecord> = {}): RepoRecord {
  return { id: nextId++, nodeId: '', owner: 'me', name, ownerAvatarUrl: null, private: true, visibility: 'private', archived: false, fork: false, pushedAt: null, ...over };
}
const hint = (r: RepoRecord, description: string, language = '', topics: string[] = []): [number, RepoHint] => [r.id, { id: r.id, description, language, topics }];
const byName = (sections: ReturnType<typeof suggestSections>, repos: RepoRecord[]) =>
  Object.fromEntries(sections.map((s) => [s.name, s.repoIds.map((id) => repos.find((r) => r.id === id)!.name)]));

describe('nameTokens', () => {
  it('splits dashes, underscores, camelCase and acronyms', () => {
    expect(nameTokens('ACMEAuthority')).toEqual(['ACME', 'Authority']);
    expect(nameTokens('BigDataIPortal')).toEqual(['Big', 'Data', 'I', 'Portal']);
    expect(nameTokens('claude-telegram-watchdog')).toEqual(['claude', 'telegram', 'watchdog']);
    expect(nameTokens('IPSpeaker_ESP32')).toEqual(['IP', 'Speaker', 'ESP', '32']);
  });
});

describe('suggestSections', () => {
  it('groups a realistic account into sensible sections and leaves unclear ones alone', () => {
    const repos = [
      repo('ACMEAuthority'),
      repo('ACMEBilling'),
      repo('ACMEGateway'),
      repo('ACMEOpsDemo'),
      repo('claude-config'),
      repo('claude-plugins', { fork: true }),
      repo('claude-watchdog'),
      repo('BakeryPublic'),
      repo('dentist-site'),
      repo('agent-relay'),
      repo('homelab-dashboard'),
      repo('PlexDownloader'),
      repo('svg-path-editor', { fork: true }),
      repo('LeadsManager'),
      repo('OldThing', { archived: true }),
      repo('Mystery'),
      repo('shared-thing', { owner: 'friend' }),
    ];
    const hints = new Map([hint(repos[8]!, 'Website for a dentist'), hint(repos[9]!, 'Relay for AI agents'), hint(repos[12]!, 'Online editor for SVG paths')]);
    const out = suggestSections({ repos, hints, login: 'ME' });
    expect(byName(out, repos)).toEqual({
      Archive: ['OldThing'],
      friend: ['shared-thing'],
      ACME: ['ACMEAuthority', 'ACMEBilling', 'ACMEGateway', 'ACMEOpsDemo'],
      Claude: ['claude-config', 'claude-plugins', 'claude-watchdog'],
      Websites: ['BakeryPublic', 'dentist-site'],
      'AI & agents': ['agent-relay'],
      'Homelab & infrastructure': ['homelab-dashboard', 'PlexDownloader'],
      'Tools & utilities': ['svg-path-editor'],
      'Apps & portals': ['LeadsManager'],
    });
    expect(out.find((s) => s.name === 'Archive')!.collapsed).toBe(true);
    expect(out.at(-1)!.name).toBe('Archive'); // claimed first, listed last
    // Never forced: a name with no signal stays in Uncategorized.
    expect(out.flatMap((s) => s.repoIds)).not.toContain(repos[15]!.id);
  });

  it('places every repository at most once', () => {
    const repos = ['ai-site-tool-app', 'ai-site-two', 'ai-site-three', 'web-ai'].map((n) => repo(n));
    const out = suggestSections({ repos, hints: new Map(), login: 'me' });
    const all = out.flatMap((s) => s.repoIds);
    expect(new Set(all).size).toBe(all.length);
  });

  it('does not make families from short common words, but does from acronyms', () => {
    const repos = ['ProGrade', 'Proactive', 'ProTools', 'XYZOne', 'XYZTwo', 'XYZThree'].map((n) => repo(n));
    const names = suggestSections({ repos, hints: new Map(), login: 'me' }).map((s) => s.name);
    expect(names).toContain('XYZ');
    expect(names).not.toContain('Pro');
  });

  it('uses languages and topics from hints', () => {
    const repos = [repo('alpha'), repo('beta')];
    const out = suggestSections({ repos, hints: new Map([hint(repos[0]!, '', 'HTML'), hint(repos[1]!, '', '', ['home-assistant'])]), login: 'me' });
    expect(byName(out, repos)).toEqual({ Websites: ['alpha'], 'Homelab & infrastructure': ['beta'] });
  });

  it('is deterministic regardless of input order', () => {
    const repos = ['b-site', 'a-site', 'c-agent'].map((n) => repo(n));
    const a = suggestSections({ repos, hints: new Map(), login: 'me' });
    const b = suggestSections({ repos: [...repos].reverse(), hints: new Map(), login: 'me' });
    expect(b).toEqual(a);
  });
});

describe('repository hints', () => {
  it('keeps only bounded description, language and topics', () => {
    expect(normalizeHint({ id: 5, description: `  a\n b ${'x'.repeat(400)}`, language: 'TypeScript', topics: ['ok', 7, 'y'.repeat(80)], secret: 1 })).toEqual({
      id: 5,
      description: `a b ${'x'.repeat(296)}`,
      language: 'TypeScript',
      topics: ['ok', 'y'.repeat(50)],
    });
    expect(normalizeHint({ id: -1 })).toBeNull();
    expect(normalizeHint({ id: 9, description: null, language: null })).toEqual({ id: 9, description: '', language: '', topics: [] });
  });

  it('reads hints from every page and installation, unconditionally, leaving the inventory’s ETag cache untouched', async () => {
    const mock = releaseFixture();
    const bases = { apiBase: 'https://api.github.com', oauthBase: 'https://github.com' };
    const clientWith = (etags: Map<string, CachedPage<unknown>>) => new GitHubClient({ apiBase: bases.apiBase, token: mock.token, fetch: mock.fetch(bases), etags, now: () => 1 });
    // The inventory's cache, primed by a normal refresh.
    const inventoryEtags = new Map<string, CachedPage<unknown>>();
    await fetchInventory(clientWith(inventoryEtags));
    const snapshot = new Map(inventoryEtags);
    mock.log.length = 0;

    const hints = await fetchRepoHints(clientWith(new Map()));
    expect(hints.size).toBe(255);
    expect(hints.get(apiRepo(240).id)!.description).toBe('Description 240 that the extension must not store');
    expect(hints.get(apiRepo(1).id)!.topics).toEqual(['secret-topic']);
    expect(mock.log.length).toBeGreaterThan(0);
    expect(mock.log.every((r) => !r.ifNoneMatch)).toBe(true);
    expect(inventoryEtags).toEqual(snapshot);
  });
});
