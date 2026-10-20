import { describe, expect, it } from 'vitest';
import { applyOps, emptyLayout } from '../../src/shared/layout/model';
import { needsStartChoice } from '../../src/shared/messages';
import { navState } from '../helpers/dom';

describe('needsStartChoice', () => {
  it('asks once the first inventory is in and nothing is organized', () => {
    expect(needsStartChoice(navState({ startChosen: false }))).toBe(true);
  });

  it('never asks again once answered', () => {
    expect(needsStartChoice(navState({ startChosen: true }))).toBe(false);
  });

  it('does not ask when sections already exist (made here or synced from another device)', () => {
    const layout = applyOps(emptyLayout(), [{ type: 'createSection', sectionId: 'work', name: 'Work', beforeSectionId: null }], { inventory: new Set() });
    expect(needsStartChoice(navState({ startChosen: false, layout }))).toBe(false);
  });

  it('waits for sign-in, for repositories, and for an editable layout', () => {
    expect(needsStartChoice(navState({ startChosen: false, auth: { kind: 'signed-out', clientIdConfigured: true, problem: null } }))).toBe(false);
    expect(needsStartChoice(navState({ startChosen: false, repos: [] }))).toBe(false);
    expect(needsStartChoice(navState({ startChosen: false, editable: false }))).toBe(false);
  });
});
