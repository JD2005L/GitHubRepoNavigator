import type { RepoRecord } from '../../src/shared/types';

const OWNERS = [
  { login: 'jd2005l', id: 1001, type: 'User' },
  { login: 'acme-corp', id: 2002, type: 'Organization' },
  { login: 'acme-labs', id: 3003, type: 'Organization' },
  { login: 'friend-dev', id: 4004, type: 'User' },
] as const;

const WORDS = ['portal', 'gateway', 'infra', 'docs', 'site', 'api', 'worker', 'mobile', 'agent', 'relay', 'design', 'tools', 'data', 'auth', 'cli'];

/** Deterministic repository number i (1-based) in GitHub REST API shape, with fields we must ignore. */
export function apiRepo(i: number) {
  const owner = OWNERS[i % OWNERS.length]!;
  const name = `${WORDS[i % WORDS.length]}-${String(i).padStart(3, '0')}`;
  const isPrivate = i % 3 !== 0;
  return {
    id: 500_000_000 + i * 7919,
    node_id: `R_kgDO${(500_000_000 + i * 7919).toString(36).toUpperCase()}`,
    name,
    full_name: `${owner.login}/${name}`,
    private: isPrivate,
    visibility: isPrivate ? 'private' : 'public',
    owner: {
      login: owner.login,
      id: owner.id,
      type: owner.type,
      avatar_url: `https://avatars.githubusercontent.com/u/${owner.id}?v=4`,
    },
    html_url: `https://github.com/${owner.login}/${name}`,
    description: `Description ${i} that the extension must not store`,
    fork: i % 11 === 0,
    archived: i % 17 === 0,
    pushed_at: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString(),
    updated_at: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString(),
    default_branch: 'main',
    topics: ['secret-topic'],
    permissions: { admin: true, push: true, pull: true },
  };
}

export type ApiRepo = ReturnType<typeof apiRepo>;

export function makeRepos(count: number, start = 1): RepoRecord[] {
  return Array.from({ length: count }, (_, k) => {
    const r = apiRepo(start + k);
    return {
      id: r.id,
      nodeId: r.node_id,
      owner: r.owner.login,
      name: r.name,
      ownerAvatarUrl: r.owner.avatar_url,
      private: r.private,
      visibility: r.visibility as RepoRecord['visibility'],
      archived: r.archived,
      fork: r.fork,
      pushedAt: r.pushed_at,
    };
  });
}
