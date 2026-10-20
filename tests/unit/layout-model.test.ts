import { describe, expect, it } from 'vitest';
import {
  UNCATEGORIZED_ID,
  applyOp,
  applyOps,
  buildView,
  cleanSectionName,
  deleteGuard,
  emptyLayout,
  normalizeLayout,
  unavailableCount,
  type LayoutOp,
} from '../../src/shared/layout/model';
import type { Layout, RepoRecord } from '../../src/shared/types';
import { makeRepos } from '../helpers/repos';

const ctx = (ids: number[]) => ({ inventory: new Set(ids) });

function must(layout: Layout, op: LayoutOp, inventory: number[] = []): Layout {
  const result = applyOp(layout, op, ctx(inventory));
  if (!result.ok) throw new Error(result.reason);
  return result.layout;
}

function withSections(...names: string[]): Layout {
  let layout = emptyLayout();
  names.forEach((name, i) => {
    layout = must(layout, { type: 'createSection', sectionId: `s${i}`, name, beforeSectionId: UNCATEGORIZED_ID });
  });
  return layout;
}

describe('layout model', () => {
  it('creates sections before Uncategorized and keeps Uncategorized unique', () => {
    const layout = withSections('Work', 'Personal');
    expect(layout.sections.map((s) => s.id)).toEqual(['s0', 's1', UNCATEGORIZED_ID]);
    expect(applyOp(layout, { type: 'createSection', sectionId: UNCATEGORIZED_ID, name: 'x', beforeSectionId: null }, ctx([])).ok).toBe(false);
  });

  it('is idempotent: replaying a create or move does not duplicate anything', () => {
    let layout = withSections('Work');
    const op: LayoutOp = { type: 'createSection', sectionId: 's0', name: 'Work again', beforeSectionId: null };
    expect(must(layout, op).sections).toHaveLength(2);
    layout = must(layout, { type: 'moveRepo', repoId: 7, toSectionId: 's0', beforeRepoId: null }, [7]);
    layout = must(layout, { type: 'moveRepo', repoId: 7, toSectionId: 's0', beforeRepoId: null }, [7]);
    expect(layout.sections[0]!.repoIds).toEqual([7]);
  });

  it('renames sections with cleaned names and refuses to rename Uncategorized or to blank', () => {
    let layout = withSections('Work');
    layout = must(layout, { type: 'renameSection', sectionId: 's0', name: '  Client\u0000  work‮ ' });
    expect(layout.sections[0]!.name).toBe('Client work');
    expect(applyOp(layout, { type: 'renameSection', sectionId: UNCATEGORIZED_ID, name: 'Inbox' }, ctx([])).ok).toBe(false);
    expect(applyOp(layout, { type: 'renameSection', sectionId: 's0', name: '   ' }, ctx([])).ok).toBe(false);
    expect(cleanSectionName('😀'.repeat(80))).toHaveLength(60 * 2); // 60 code points, emoji are 2 UTF-16 units
  });

  it('reorders sections, including Uncategorized', () => {
    let layout = withSections('A', 'B', 'C');
    layout = must(layout, { type: 'moveSection', sectionId: 's2', beforeSectionId: 's0' });
    expect(layout.sections.map((s) => s.id)).toEqual(['s2', 's0', 's1', UNCATEGORIZED_ID]);
    layout = must(layout, { type: 'moveSection', sectionId: UNCATEGORIZED_ID, beforeSectionId: 's2' });
    expect(layout.sections[0]!.id).toBe(UNCATEGORIZED_ID);
    layout = must(layout, { type: 'moveSection', sectionId: 's2', beforeSectionId: null });
    expect(layout.sections.at(-1)!.id).toBe('s2');
  });

  it('moves repositories within and between sections by anchor, keeping hidden IDs in place', () => {
    let layout = withSections('A', 'B');
    for (const id of [1, 2, 3, 99]) layout = must(layout, { type: 'moveRepo', repoId: id, toSectionId: 's0', beforeRepoId: null }, [1, 2, 3]);
    // 99 is not in this device's inventory; it must survive moves untouched.
    layout = must(layout, { type: 'moveRepo', repoId: 3, toSectionId: 's0', beforeRepoId: 1 }, [1, 2, 3]);
    expect(layout.sections[0]!.repoIds).toEqual([3, 1, 2, 99]);
    layout = must(layout, { type: 'moveRepo', repoId: 1, toSectionId: 's1', beforeRepoId: null }, [1, 2, 3]);
    expect(layout.sections[0]!.repoIds).toEqual([3, 2, 99]);
    expect(layout.sections[1]!.repoIds).toEqual([1]);
    // Moving to Uncategorized unassigns.
    layout = must(layout, { type: 'moveRepo', repoId: 1, toSectionId: UNCATEGORIZED_ID, beforeRepoId: null }, [1, 2, 3]);
    expect(layout.sections[1]!.repoIds).toEqual([]);
    expect(layout.sections.find((s) => s.id === UNCATEGORIZED_ID)!.repoIds).toEqual([]);
  });

  it('only deletes sections that show no repositories, and explains why otherwise', () => {
    let layout = withSections('Work');
    layout = must(layout, { type: 'moveRepo', repoId: 5, toSectionId: 's0', beforeRepoId: null }, [5]);
    const guard = deleteGuard(layout, 's0', ctx([5]));
    expect(guard).toMatchObject({ allowed: false, reason: 'not-empty', count: 1 });
    expect(guard.allowed ? '' : guard.message).toMatch(/Move its 1 repository/);
    expect(applyOp(layout, { type: 'deleteSection', sectionId: 's0' }, ctx([5])).ok).toBe(false);
    expect(deleteGuard(layout, UNCATEGORIZED_ID, ctx([5]))).toMatchObject({ allowed: false, reason: 'builtin' });
    // A device that cannot see repo 5 must not delete it either: the placement belongs to another device.
    const elsewhere = deleteGuard(layout, 's0', ctx([]));
    expect(elsewhere).toMatchObject({ allowed: false, reason: 'not-empty', count: 1 });
    expect(elsewhere.allowed ? '' : elsewhere.message).toMatch(/not available on this device/);
    expect(applyOp(layout, { type: 'deleteSection', sectionId: 's0' }, ctx([])).ok).toBe(false);
    // Once the section holds nothing at all it can be deleted.
    const emptied = must(layout, { type: 'moveRepo', repoId: 5, toSectionId: UNCATEGORIZED_ID, beforeRepoId: null }, [5]);
    expect(must(emptied, { type: 'deleteSection', sectionId: 's0' }, []).sections.map((s) => s.id)).toEqual([UNCATEGORIZED_ID]);
  });

  it('normalizes hostile or duplicated input', () => {
    const layout = normalizeLayout({
      sections: [
        { id: 'a', name: '', collapsed: true, repoIds: [1, 2, 2] },
        { id: 'a', name: 'dup', collapsed: false, repoIds: [3] },
        { id: 'b c', name: 'bad id', collapsed: false, repoIds: [4] },
        { id: 'b', name: 'B', collapsed: false, repoIds: [2, 5, -1, 1.5, Number.MAX_SAFE_INTEGER + 2] },
        { id: UNCATEGORIZED_ID, name: 'Renamed', collapsed: true, repoIds: [9] },
      ],
      extra: {},
    });
    expect(layout.sections).toEqual([
      { id: 'a', name: 'Untitled', collapsed: true, repoIds: [1, 2] },
      { id: 'b', name: 'B', collapsed: false, repoIds: [5] },
      { id: UNCATEGORIZED_ID, name: 'Uncategorized', collapsed: true, repoIds: [] },
    ]);
    expect(normalizeLayout({ sections: [], extra: {} }).sections.map((s) => s.id)).toEqual([UNCATEGORIZED_ID]);
  });

  it('builds the view: each repo once, new repos in Uncategorized sorted by owner/name', () => {
    const repos = makeRepos(6);
    let layout = withSections('Work');
    layout = must(layout, { type: 'moveRepo', repoId: repos[4]!.id, toSectionId: 's0', beforeRepoId: null }, repos.map((r) => r.id));
    layout = must(layout, { type: 'moveRepo', repoId: 424242, toSectionId: 's0', beforeRepoId: null }, repos.map((r) => r.id));
    const view = buildView(layout, repos);
    expect(view[0]!.repos.map((r) => r.id)).toEqual([repos[4]!.id]);
    expect(view[0]!.unavailable).toBe(1);
    const unc = view.find((v) => v.section.id === UNCATEGORIZED_ID)!;
    expect(unc.repos).toHaveLength(5);
    const names = unc.repos.map((r: RepoRecord) => `${r.owner}/${r.name}`.toLowerCase());
    expect(names).toEqual([...names].sort());
    expect(unavailableCount(layout, new Set(repos.map((r) => r.id)))).toBe(1);
  });

  it('keeps categorization across rename and transfer because only the ID is stored', () => {
    const [repo] = makeRepos(1);
    let layout = withSections('Work');
    layout = must(layout, { type: 'moveRepo', repoId: repo!.id, toSectionId: 's0', beforeRepoId: null }, [repo!.id]);
    const renamed: RepoRecord = { ...repo!, owner: 'new-org', name: 'renamed-repo' };
    const view = buildView(layout, [renamed]);
    expect(view[0]!.repos[0]).toMatchObject({ id: repo!.id, owner: 'new-org', name: 'renamed-repo' });
  });

  it('rebases pending ops onto a newer remote layout and skips ops that no longer apply', () => {
    const base = withSections('Work', 'Play');
    const pending: LayoutOp[] = [
      { type: 'moveRepo', repoId: 1, toSectionId: 's1', beforeRepoId: null },
      { type: 'renameSection', sectionId: 's0', name: 'Job' },
    ];
    // Remote device deleted "Work" and added a section meanwhile.
    let remote = must(base, { type: 'deleteSection', sectionId: 's0' });
    remote = must(remote, { type: 'createSection', sectionId: 'r1', name: 'Remote', beforeSectionId: null });
    const rebased = applyOps(remote, pending, ctx([1]));
    expect(rebased.sections.map((s) => s.id)).toEqual(['s1', UNCATEGORIZED_ID, 'r1']);
    expect(rebased.sections[0]!.repoIds).toEqual([1]);
  });
});
