import { describe, expect, it } from 'vitest';
import { UNCATEGORIZED_ID, applyOps, emptyLayout, type LayoutOp } from '../../src/shared/layout/model';
import { SECTIONS_FORMAT, chunkOps, exportSections, opsForPlan, parseSectionsFile, planImport, planSections } from '../../src/shared/layout/transfer';
import type { Layout } from '../../src/shared/types';
import { makeRepos } from '../helpers/repos';

const repos = makeRepos(10);
const inventory = new Set(repos.map((r) => r.id));
const apply = (layout: Layout, ops: LayoutOp[]) => applyOps(layout, ops, { inventory });
let n = 0;
const ids = () => `s${++n}`;

function layoutWith(sections: { name: string; repoIds: number[] }[]): Layout {
  const ops: LayoutOp[] = [];
  sections.forEach((s, i) => {
    ops.push({ type: 'createSection', sectionId: `x${i}`, name: s.name, beforeSectionId: UNCATEGORIZED_ID });
    for (const id of s.repoIds) ops.push({ type: 'moveRepo', repoId: id, toSectionId: `x${i}`, beforeRepoId: null });
  });
  return apply(emptyLayout(), ops);
}

describe('export and import', () => {
  it('round-trips sections, order and collapsed state', () => {
    let layout = layoutWith([
      { name: 'Work', repoIds: [repos[2]!.id, repos[0]!.id] },
      { name: 'Side', repoIds: [repos[5]!.id] },
    ]);
    layout = apply(layout, [{ type: 'setCollapsed', sectionId: 'x1', collapsed: true }]);
    const file = exportSections(layout, repos, new Date('2026-10-01T00:00:00Z'));
    expect(file.format).toBe(SECTIONS_FORMAT);
    expect(file.sections.map((s) => s.name)).toEqual(['Work', 'Side']);
    expect(file.sections[0]!.repositories[0]).toEqual({ id: repos[2]!.id, fullName: `${repos[2]!.owner}/${repos[2]!.name}` });

    const parsed = parseSectionsFile(JSON.stringify(file));
    expect(parsed.ok).toBe(true);
    const plan = planImport(parsed.ok ? parsed.file : (null as never), emptyLayout(), repos);
    const restored = apply(emptyLayout(), opsForPlan(plan, ids).ops);
    expect(restored.sections.map((s) => [s.name, s.collapsed, s.repoIds])).toEqual([
      ['Work', false, [repos[2]!.id, repos[0]!.id]],
      ['Side', true, [repos[5]!.id]],
      ['Uncategorized', false, []],
    ]);
  });

  it('matches by name when the ID is unknown here, and counts what it cannot find', () => {
    const text = JSON.stringify({
      format: SECTIONS_FORMAT,
      version: 1,
      sections: [{ name: 'Mine', repositories: [{ id: 1, fullName: `${repos[3]!.owner}/${repos[3]!.name.toUpperCase()}` }, { id: 2, fullName: 'nobody/nothing' }] }],
    });
    const parsed = parseSectionsFile(text);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(planImport(parsed.file, emptyLayout(), repos)).toEqual([{ name: 'Mine', collapsed: false, existingId: null, repoIds: [repos[3]!.id], missing: 1 }]);
  });

  it('merges into an existing section of the same name instead of duplicating it', () => {
    const layout = layoutWith([{ name: 'Work', repoIds: [repos[0]!.id] }]);
    const plan = planSections([{ name: '  work ', collapsed: false, repoIds: [repos[1]!.id] }], layout);
    expect(plan[0]!.existingId).toBe('x0');
    const { ops, created } = opsForPlan(plan, ids);
    expect(created).toEqual([]);
    expect(apply(layout, ops).sections[0]!.repoIds).toEqual([repos[0]!.id, repos[1]!.id]);
  });

  it('can be undone exactly: unassign what moved, delete what was created', () => {
    const before = layoutWith([{ name: 'Keep', repoIds: [repos[9]!.id] }]);
    const { ops, created, moved } = opsForPlan(planSections([{ name: 'New', collapsed: false, repoIds: [repos[1]!.id, repos[2]!.id] }], before), ids);
    const after = apply(before, ops);
    const undone = apply(after, [{ type: 'unassign', repoIds: moved }, ...created.map((id) => ({ type: 'deleteSection' as const, sectionId: id, expectRepoIds: [] }))]);
    expect(undone).toEqual(before);
  });

  it('rejects files that are not sections files, or are malformed', () => {
    expect(parseSectionsFile('nope')).toEqual({ ok: false, error: 'That file is not valid JSON.' });
    expect(parseSectionsFile('\uFEFF' + JSON.stringify({ format: SECTIONS_FORMAT, version: 1, sections: [] })).ok).toBe(true);
    expect(parseSectionsFile('{"format":"other"}').ok).toBe(false);
    expect(parseSectionsFile(JSON.stringify({ format: SECTIONS_FORMAT, version: 2, sections: [] }))).toMatchObject({ ok: false, error: expect.stringMatching(/newer version/) });
    expect(parseSectionsFile(JSON.stringify({ format: SECTIONS_FORMAT, version: 1, sections: [{ name: '', repositories: [] }] })).ok).toBe(false);
    expect(parseSectionsFile(JSON.stringify({ format: SECTIONS_FORMAT, version: 1, sections: [{ name: 'A', repositories: [{ id: -3, fullName: '../etc' }] }] })).ok).toBe(false);
  });

  it('keeps each request under the background’s operation cap', () => {
    const ops: LayoutOp[] = Array.from({ length: 1201 }, (_, i) => ({ type: 'setCollapsed', sectionId: `s${i}`, collapsed: true }));
    expect(chunkOps(ops).map((c) => c.length)).toEqual([500, 500, 201]);
  });
});
