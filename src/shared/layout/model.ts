import type { Layout, RepoId, RepoRecord, Section } from '../types';

export const UNCATEGORIZED_ID = 'uncategorized';
export const UNCATEGORIZED_NAME = 'Uncategorized';
export const MAX_SECTION_NAME = 60;
export const MAX_SECTIONS = 200;
const SECTION_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Every layout change is one of these operations. They are deliberately idempotent ("put X before Y",
 * "set collapsed") and anchored on IDs rather than visible indices, so they can be replayed on top of a
 * newer remote layout (rebase) and applied twice without changing the result.
 *
 * Operations whose meaning depends on this device's inventory are resolved into concrete form when they are
 * accepted (`resolveOp`), so a later replay — against another device's document or after the inventory has
 * been cleared — can never widen their effect.
 */
export type LayoutOp =
  | { type: 'createSection'; sectionId: string; name: string; beforeSectionId: string | null }
  | { type: 'renameSection'; sectionId: string; name: string }
  /** `expectRepoIds`: the section's assignments when the user deleted it; a replay that finds others is refused. */
  | { type: 'deleteSection'; sectionId: string; expectRepoIds?: RepoId[] }
  | { type: 'moveSection'; sectionId: string; beforeSectionId: string | null }
  | { type: 'setCollapsed'; sectionId: string; collapsed: boolean }
  | { type: 'moveRepo'; repoId: RepoId; toSectionId: string; beforeRepoId: RepoId | null }
  /** Request form only: resolved into `unassign` with the concrete IDs before it is stored or replayed. */
  | { type: 'removeUnavailable' }
  | { type: 'unassign'; repoIds: RepoId[] };

export interface OpContext {
  /** IDs present in this device's current inventory. */
  inventory: ReadonlySet<RepoId>;
}

export type OpResult = { ok: true; layout: Layout } | { ok: false; reason: string };

export function emptyLayout(): Layout {
  return { sections: [{ id: UNCATEGORIZED_ID, name: UNCATEGORIZED_NAME, collapsed: false, repoIds: [] }], extra: {} };
}

export function isValidSectionId(id: unknown): id is string {
  return typeof id === 'string' && SECTION_ID_RE.test(id);
}

export function isValidRepoId(id: unknown): id is RepoId {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
}

const isAnchor = (v: unknown) => v === null || isValidRepoId(v);
const isSectionAnchor = (v: unknown) => v === null || isValidSectionId(v);
const isName = (v: unknown) => typeof v === 'string' && v.length <= 1000;

/** Full shape check for an operation from any untrusted source (messages, the persisted mirror). */
export function isValidLayoutOp(value: unknown): value is LayoutOp {
  if (!value || typeof value !== 'object') return false;
  const op = value as Record<string, unknown>;
  switch (op.type) {
    case 'createSection':
      return isValidSectionId(op.sectionId) && isName(op.name) && isSectionAnchor(op.beforeSectionId);
    case 'renameSection':
      return isValidSectionId(op.sectionId) && isName(op.name);
    case 'deleteSection':
      return isValidSectionId(op.sectionId) && (op.expectRepoIds === undefined || (Array.isArray(op.expectRepoIds) && op.expectRepoIds.every(isValidRepoId)));
    case 'moveSection':
      return isValidSectionId(op.sectionId) && isSectionAnchor(op.beforeSectionId);
    case 'setCollapsed':
      return isValidSectionId(op.sectionId) && typeof op.collapsed === 'boolean';
    case 'moveRepo':
      return isValidRepoId(op.repoId) && isValidSectionId(op.toSectionId) && isAnchor(op.beforeRepoId);
    case 'removeUnavailable':
      return true;
    case 'unassign':
      return Array.isArray(op.repoIds) && op.repoIds.length <= 20_000 && op.repoIds.every(isValidRepoId);
    default:
      return false;
  }
}

/** Trims, collapses whitespace, strips control characters and caps length (by code points). */
export function cleanSectionName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(cleaned).slice(0, MAX_SECTION_NAME).join('').trim();
}

export function newSectionId(random: () => number = Math.random): string {
  let out = 's';
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = new Uint8Array(10);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function' && random === Math.random) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256);
  }
  for (const b of bytes) out += alphabet[b % 36];
  return out;
}

function cloneSection(s: Section): Section {
  const copy: Section = { id: s.id, name: s.name, collapsed: s.collapsed, repoIds: s.repoIds.slice() };
  if (s.extra && s.extra.length) copy.extra = s.extra.slice();
  return copy;
}

function cloneLayout(layout: Layout): Layout {
  return { sections: layout.sections.map(cloneSection), extra: { ...layout.extra } };
}

/**
 * Restores every invariant regardless of input quality:
 * - exactly one Uncategorized section (with its fixed name, no explicit IDs);
 * - unique, well-formed section IDs and non-empty clean names;
 * - each repository ID in at most one section (first occurrence in section order wins);
 * - bounded section count.
 */
export function normalizeLayout(input: Layout): Layout {
  const seenSections = new Set<string>();
  const seenRepos = new Set<RepoId>();
  const sections: Section[] = [];
  let hasUncategorized = false;
  for (const raw of input.sections) {
    if (!isValidSectionId(raw.id) || seenSections.has(raw.id)) continue;
    if (sections.length >= MAX_SECTIONS && raw.id !== UNCATEGORIZED_ID) continue;
    seenSections.add(raw.id);
    const section = cloneSection(raw);
    section.collapsed = raw.collapsed === true;
    if (section.id === UNCATEGORIZED_ID) {
      hasUncategorized = true;
      section.name = UNCATEGORIZED_NAME;
      section.repoIds = [];
    } else {
      section.name = cleanSectionName(typeof raw.name === 'string' ? raw.name : '') || 'Untitled';
      section.repoIds = raw.repoIds.filter((id) => {
        if (!isValidRepoId(id) || seenRepos.has(id)) return false;
        seenRepos.add(id);
        return true;
      });
    }
    sections.push(section);
  }
  if (!hasUncategorized) sections.push({ id: UNCATEGORIZED_ID, name: UNCATEGORIZED_NAME, collapsed: false, repoIds: [] });
  return { sections, extra: { ...input.extra } };
}

/** Number of repositories a section shows on this device. */
export function visibleCount(section: Section, ctx: OpContext, layout?: Layout): number {
  if (section.id === UNCATEGORIZED_ID) {
    if (!layout) return 0;
    const assigned = assignedIds(layout);
    let count = 0;
    for (const id of ctx.inventory) if (!assigned.has(id)) count++;
    return count;
  }
  return section.repoIds.filter((id) => ctx.inventory.has(id)).length;
}

export function assignedIds(layout: Layout): Set<RepoId> {
  const ids = new Set<RepoId>();
  for (const s of layout.sections) for (const id of s.repoIds) ids.add(id);
  return ids;
}

export type DeleteGuard = { allowed: true } | { allowed: false; reason: 'builtin' | 'not-empty' | 'missing'; count: number; message: string };

export function deleteGuard(layout: Layout, sectionId: string, ctx: OpContext): DeleteGuard {
  const section = layout.sections.find((s) => s.id === sectionId);
  if (!section) return { allowed: false, reason: 'missing', count: 0, message: 'This section no longer exists.' };
  if (section.id === UNCATEGORIZED_ID) {
    return { allowed: false, reason: 'builtin', count: 0, message: 'Uncategorized is built in. It holds every repository you have not placed in a section.' };
  }
  // "Empty" means no placements at all: a section that only looks empty here may hold repositories placed on
  // another device (or an account this device is not connected to), and deleting it would discard them there.
  const visible = visibleCount(section, ctx);
  const elsewhere = section.repoIds.length - visible;
  if (visible > 0) {
    const noun = visible === 1 ? 'repository' : 'repositories';
    return { allowed: false, reason: 'not-empty', count: visible, message: `Only empty sections can be deleted. Move its ${visible} ${noun} to another section first.` };
  }
  if (elsewhere > 0) {
    const noun = elsewhere === 1 ? 'repository' : 'repositories';
    return {
      allowed: false,
      reason: 'not-empty',
      count: elsewhere,
      message: `Only empty sections can be deleted. It still holds ${elsewhere} ${noun} not available on this device (placed on another device, or no longer accessible). Move them on a device that shows them, or use Options \u2192 Forget unavailable.`,
    };
  }
  return { allowed: true };
}

function indexOfSection(layout: Layout, id: string): number {
  return layout.sections.findIndex((s) => s.id === id);
}

export function applyOp(input: Layout, op: LayoutOp, ctx: OpContext): OpResult {
  const layout = cloneLayout(input);
  switch (op.type) {
    case 'createSection': {
      if (!isValidSectionId(op.sectionId) || op.sectionId === UNCATEGORIZED_ID) return { ok: false, reason: 'Invalid section id.' };
      if (indexOfSection(layout, op.sectionId) !== -1) return { ok: true, layout }; // idempotent replay
      if (layout.sections.length >= MAX_SECTIONS) return { ok: false, reason: `You can have at most ${MAX_SECTIONS} sections.` };
      const name = cleanSectionName(op.name);
      if (!name) return { ok: false, reason: 'Section name cannot be empty.' };
      const section: Section = { id: op.sectionId, name, collapsed: false, repoIds: [] };
      const before = op.beforeSectionId === null ? -1 : indexOfSection(layout, op.beforeSectionId);
      if (before === -1) layout.sections.push(section);
      else layout.sections.splice(before, 0, section);
      return { ok: true, layout };
    }
    case 'renameSection': {
      const section = layout.sections.find((s) => s.id === op.sectionId);
      if (!section) return { ok: false, reason: 'This section no longer exists.' };
      if (section.id === UNCATEGORIZED_ID) return { ok: false, reason: 'Uncategorized cannot be renamed.' };
      const name = cleanSectionName(op.name);
      if (!name) return { ok: false, reason: 'Section name cannot be empty.' };
      section.name = name;
      return { ok: true, layout };
    }
    case 'deleteSection': {
      const idx = indexOfSection(layout, op.sectionId);
      if (idx === -1) return { ok: true, layout }; // already gone: idempotent
      if (op.expectRepoIds) {
        // Resolved delete: the user saw this section empty. Refuse if anything was placed in it since.
        if (op.sectionId === UNCATEGORIZED_ID) return { ok: false, reason: 'Uncategorized is built in.' };
        const expected = new Set(op.expectRepoIds);
        if (layout.sections[idx]!.repoIds.some((id) => !expected.has(id))) return { ok: false, reason: 'Repositories were added to this section in the meantime.' };
        layout.sections.splice(idx, 1);
        return { ok: true, layout };
      }
      const guard = deleteGuard(layout, op.sectionId, ctx);
      if (!guard.allowed) return { ok: false, reason: guard.message };
      // Any IDs this device cannot see fall back to Uncategorized everywhere (they are simply unassigned).
      layout.sections.splice(idx, 1);
      return { ok: true, layout };
    }
    case 'moveSection': {
      const idx = indexOfSection(layout, op.sectionId);
      if (idx === -1) return { ok: false, reason: 'This section no longer exists.' };
      if (op.beforeSectionId === op.sectionId) return { ok: true, layout };
      const [section] = layout.sections.splice(idx, 1);
      const before = op.beforeSectionId === null ? -1 : indexOfSection(layout, op.beforeSectionId);
      if (before === -1) layout.sections.push(section!);
      else layout.sections.splice(before, 0, section!);
      return { ok: true, layout };
    }
    case 'setCollapsed': {
      const section = layout.sections.find((s) => s.id === op.sectionId);
      if (!section) return { ok: false, reason: 'This section no longer exists.' };
      section.collapsed = op.collapsed;
      return { ok: true, layout };
    }
    case 'moveRepo': {
      if (!isValidRepoId(op.repoId)) return { ok: false, reason: 'Invalid repository id.' };
      const target = layout.sections.find((s) => s.id === op.toSectionId);
      if (!target) return { ok: false, reason: 'That section no longer exists.' };
      if (op.beforeRepoId === op.repoId) return { ok: true, layout };
      for (const s of layout.sections) {
        const i = s.repoIds.indexOf(op.repoId);
        if (i !== -1) s.repoIds.splice(i, 1);
      }
      // Uncategorized is automatic (sorted, never stored): moving there just unassigns.
      if (target.id === UNCATEGORIZED_ID) return { ok: true, layout };
      const before = op.beforeRepoId === null ? -1 : target.repoIds.indexOf(op.beforeRepoId);
      if (before === -1) target.repoIds.push(op.repoId);
      else target.repoIds.splice(before, 0, op.repoId);
      return { ok: true, layout };
    }
    case 'removeUnavailable': {
      // Never against an empty inventory: that would mean "forget everything".
      if (ctx.inventory.size === 0) return { ok: false, reason: 'Refresh your repositories first so nothing available is removed.' };
      for (const s of layout.sections) s.repoIds = s.repoIds.filter((id) => ctx.inventory.has(id));
      return { ok: true, layout };
    }
    case 'unassign': {
      if (!Array.isArray(op.repoIds) || !op.repoIds.every(isValidRepoId)) return { ok: false, reason: 'Invalid repository ids.' };
      const drop = new Set(op.repoIds);
      for (const s of layout.sections) s.repoIds = s.repoIds.filter((id) => !drop.has(id));
      return { ok: true, layout };
    }
  }
}

/**
 * Turns an operation into the concrete form that is stored and replayed. Inventory-dependent requests are
 * pinned to what this device sees right now.
 */
export function resolveOp(layout: Layout, op: LayoutOp, ctx: OpContext): LayoutOp {
  switch (op.type) {
    case 'removeUnavailable': {
      if (ctx.inventory.size === 0) return op; // refused by applyOp
      const repoIds = [...new Set(layout.sections.flatMap((s) => s.repoIds.filter((id) => !ctx.inventory.has(id))))];
      return { type: 'unassign', repoIds };
    }
    case 'deleteSection': {
      if (op.expectRepoIds) return op;
      const section = layout.sections.find((s) => s.id === op.sectionId);
      return section ? { type: 'deleteSection', sectionId: op.sectionId, expectRepoIds: section.repoIds.slice() } : op;
    }
    default:
      return op;
  }
}

/** Applies ops in order, skipping ones that no longer make sense (e.g. their section was deleted remotely). */
export function applyOps(layout: Layout, ops: readonly LayoutOp[], ctx: OpContext): Layout {
  let current = layout;
  for (const op of ops) {
    if (!isValidLayoutOp(op)) continue;
    try {
      const result = applyOp(current, op, ctx);
      if (result.ok) current = result.layout;
    } catch {
      // A malformed operation must never take the whole layout (or the worker) down with it.
    }
  }
  return current;
}

export interface SectionView {
  section: Section;
  repos: RepoRecord[];
  /** Assigned IDs this device cannot see (inaccessible here, deleted, or not yet fetched). */
  unavailable: number;
}

export function compareRepos(a: RepoRecord, b: RepoRecord): number {
  const ka = `${a.owner}/${a.name}`.toLowerCase();
  const kb = `${b.owner}/${b.name}`.toLowerCase();
  if (ka < kb) return -1;
  if (ka > kb) return 1;
  return a.id - b.id;
}

/**
 * Joins the synced layout with this device's inventory. Each inventory repository is rendered exactly once:
 * in the first section that lists it, otherwise in Uncategorized (sorted by owner/name, so the result is the
 * same on every device).
 */
export function buildView(layout: Layout, repos: readonly RepoRecord[]): SectionView[] {
  const byId = new Map<RepoId, RepoRecord>();
  for (const r of repos) byId.set(r.id, r);
  const placed = new Set<RepoId>();
  const views: SectionView[] = layout.sections.map((section) => {
    if (section.id === UNCATEGORIZED_ID) return { section, repos: [], unavailable: 0 };
    const list: RepoRecord[] = [];
    let unavailable = 0;
    for (const id of section.repoIds) {
      const repo = byId.get(id);
      if (!repo) unavailable++;
      else if (!placed.has(id)) {
        placed.add(id);
        list.push(repo);
      }
    }
    return { section, repos: list, unavailable };
  });
  const uncategorized = views.find((v) => v.section.id === UNCATEGORIZED_ID);
  if (uncategorized) uncategorized.repos = repos.filter((r) => !placed.has(r.id)).sort(compareRepos);
  return views;
}

/** Count of assigned IDs missing from the inventory, across all sections. */
export function unavailableCount(layout: Layout, inventory: ReadonlySet<RepoId>): number {
  let n = 0;
  for (const s of layout.sections) for (const id of s.repoIds) if (!inventory.has(id)) n++;
  return n;
}

export function layoutsEqual(a: Layout, b: Layout): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
