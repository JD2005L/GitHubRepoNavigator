import { describe, expect, it } from 'vitest';
import { computeRepoDrop, computeSectionDrop, type RepoDropItem } from '../../src/content/ui/dnd';

// Work (expanded): header 0-32, repos 1 (32-64), 2 (64-96); Later (collapsed): header 100-132;
// Empty (expanded): header 140-172, placeholder 172-200; Uncategorized (automatic): header 210-242, repo 9 (242-274).
const items: RepoDropItem[] = [
  { kind: 'header', sectionId: 'work', top: 0, bottom: 32, collapsed: false, automatic: false },
  { kind: 'repo', sectionId: 'work', repoId: 1, top: 32, bottom: 64, collapsed: false, automatic: false },
  { kind: 'repo', sectionId: 'work', repoId: 2, top: 64, bottom: 96, collapsed: false, automatic: false },
  { kind: 'header', sectionId: 'later', top: 100, bottom: 132, collapsed: true, automatic: false },
  { kind: 'header', sectionId: 'empty', top: 140, bottom: 172, collapsed: false, automatic: false },
  { kind: 'empty', sectionId: 'empty', top: 172, bottom: 200, collapsed: false, automatic: false },
  { kind: 'header', sectionId: 'uncategorized', top: 210, bottom: 242, collapsed: false, automatic: true },
  { kind: 'repo', sectionId: 'uncategorized', repoId: 9, top: 242, bottom: 274, collapsed: false, automatic: true },
];

describe('drop geometry', () => {
  it('inserts before or after a row depending on which half the pointer is in', () => {
    expect(computeRepoDrop(40, items)).toEqual({ sectionId: 'work', beforeRepoId: 1, indicator: { kind: 'line', y: 32 } });
    expect(computeRepoDrop(60, items)).toEqual({ sectionId: 'work', beforeRepoId: 2, indicator: { kind: 'line', y: 64 } });
    expect(computeRepoDrop(90, items)).toEqual({ sectionId: 'work', beforeRepoId: null, indicator: { kind: 'line', y: 96 } });
  });

  it('drops at the top of an expanded section when over its header', () => {
    expect(computeRepoDrop(10, items)).toEqual({ sectionId: 'work', beforeRepoId: 1, indicator: { kind: 'line', y: 32 } });
  });

  it('appends to collapsed and empty sections and highlights them', () => {
    expect(computeRepoDrop(110, items)).toEqual({ sectionId: 'later', beforeRepoId: null, indicator: { kind: 'section', sectionId: 'later' } });
    expect(computeRepoDrop(180, items)).toEqual({ sectionId: 'empty', beforeRepoId: null, indicator: { kind: 'section', sectionId: 'empty' } });
  });

  it('treats Uncategorized as one target because it is sorted automatically', () => {
    expect(computeRepoDrop(250, items)).toEqual({ sectionId: 'uncategorized', beforeRepoId: null, indicator: { kind: 'section', sectionId: 'uncategorized' } });
  });

  it('uses the nearest zone above for gaps and clamps outside the list', () => {
    expect(computeRepoDrop(98, items)!.sectionId).toBe('work');
    expect(computeRepoDrop(-50, items)!.sectionId).toBe('work');
    expect(computeRepoDrop(999, items)!.sectionId).toBe('uncategorized');
    expect(computeRepoDrop(10, [])).toBeNull();
  });

  it('drops sections between sections', () => {
    const boxes = [
      { sectionId: 'a', top: 0, bottom: 100 },
      { sectionId: 'b', top: 100, bottom: 140 },
      { sectionId: 'c', top: 140, bottom: 300 },
    ];
    expect(computeSectionDrop(10, boxes)).toEqual({ beforeSectionId: 'a', y: 0 });
    expect(computeSectionDrop(115, boxes)).toEqual({ beforeSectionId: 'b', y: 100 });
    expect(computeSectionDrop(260, boxes)).toEqual({ beforeSectionId: null, y: 300 });
  });
});
