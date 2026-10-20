import type { Layout, RepoId, RepoRecord } from '../types';
import { MAX_SECTIONS, UNCATEGORIZED_ID, cleanSectionName, newSectionId, type LayoutOp } from './model';

/**
 * Sections as a file (export, import, backup, sharing) and the one place that turns "these sections with
 * these repositories" into layout operations, used by both import and suggestions.
 *
 * A file lists repositories by immutable ID plus their owner/name at export time, so it still applies after a
 * rename (by ID) and on another account that sees the same repositories under another ID (by name).
 */

export const SECTIONS_FORMAT = 'github-repo-navigator/sections';
export const SECTIONS_VERSION = 1;
const MAX_FILE_REPOS = 20_000;

export interface SectionsFile {
  format: typeof SECTIONS_FORMAT;
  version: number;
  exportedAt: string;
  sections: { name: string; collapsed: boolean; repositories: { id: RepoId | null; fullName: string | null }[] }[];
}

const fullName = (r: RepoRecord) => `${r.owner}/${r.name}`;

export function exportSections(layout: Layout, repos: readonly RepoRecord[], now: Date): SectionsFile {
  const byId = new Map(repos.map((r) => [r.id, r]));
  return {
    format: SECTIONS_FORMAT,
    version: SECTIONS_VERSION,
    exportedAt: now.toISOString(),
    sections: layout.sections
      .filter((s) => s.id !== UNCATEGORIZED_ID)
      .map((s) => ({
        name: s.name,
        collapsed: s.collapsed,
        repositories: s.repoIds.map((id) => ({ id, fullName: byId.has(id) ? fullName(byId.get(id)!) : null })),
      })),
  };
}

/** Strict parse of an untrusted file. Unknown extra fields are ignored; anything malformed is an error. */
export function parseSectionsFile(text: string): { ok: true; file: SectionsFile } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, '')); // Windows editors often save a byte-order mark
  } catch {
    return { ok: false, error: 'That file is not valid JSON.' };
  }
  const bad = (error: string) => ({ ok: false as const, error });
  if (!raw || typeof raw !== 'object') return bad('That file is not a sections file.');
  const r = raw as Record<string, unknown>;
  if (r.format !== SECTIONS_FORMAT) return bad('That file is not a GitHub Repo Navigator sections file.');
  if (r.version !== SECTIONS_VERSION) return bad('That sections file was made by a newer version of the extension. Update the extension, then import it.');
  if (!Array.isArray(r.sections)) return bad('That sections file has no sections.');
  if (r.sections.length > MAX_SECTIONS) return bad(`That file has more than ${MAX_SECTIONS} sections.`);
  const sections: SectionsFile['sections'] = [];
  let total = 0;
  for (const s of r.sections as unknown[]) {
    if (!s || typeof s !== 'object') return bad('A section in that file is malformed.');
    const section = s as Record<string, unknown>;
    const name = typeof section.name === 'string' ? cleanSectionName(section.name) : '';
    if (!name) return bad('A section in that file has no name.');
    if (!Array.isArray(section.repositories)) return bad(`Section “${name}” has no repository list.`);
    const repositories: SectionsFile['sections'][number]['repositories'] = [];
    for (const entry of section.repositories as unknown[]) {
      if (!entry || typeof entry !== 'object') return bad(`Section “${name}” has a malformed repository.`);
      const e = entry as Record<string, unknown>;
      const id = typeof e.id === 'number' && Number.isSafeInteger(e.id) && e.id > 0 ? e.id : null;
      const full = typeof e.fullName === 'string' && /^[A-Za-z0-9_-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(e.fullName) ? e.fullName : null;
      if (id === null && full === null) return bad(`Section “${name}” has a repository with neither an ID nor a name.`);
      repositories.push({ id, fullName: full });
    }
    total += repositories.length;
    if (total > MAX_FILE_REPOS) return bad('That file lists too many repositories.');
    sections.push({ name, collapsed: section.collapsed === true, repositories });
  }
  return { ok: true, file: { format: SECTIONS_FORMAT, version: SECTIONS_VERSION, exportedAt: typeof r.exportedAt === 'string' ? r.exportedAt.slice(0, 40) : '', sections } };
}

/** What applying would do: one entry per target section, merged into an existing section of the same name. */
export interface PlanSection {
  name: string;
  collapsed: boolean;
  /** Existing section receiving the repositories, or null to create one. */
  existingId: string | null;
  repoIds: RepoId[];
  /** Listed in the file but not visible on this device (shown in the preview, skipped). */
  missing: number;
}

function existingByName(layout: Layout): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of layout.sections) if (s.id !== UNCATEGORIZED_ID && !map.has(s.name.toLowerCase())) map.set(s.name.toLowerCase(), s.id);
  return map;
}

/** Matches file entries to visible repositories (ID first, then owner/name). A repository goes to its first section only. */
export function planImport(file: SectionsFile, layout: Layout, repos: readonly RepoRecord[]): PlanSection[] {
  const byId = new Map(repos.map((r) => [r.id, r]));
  const byName = new Map(repos.map((r) => [fullName(r).toLowerCase(), r]));
  const existing = existingByName(layout);
  const used = new Set<RepoId>();
  const merged = new Map<string, PlanSection>();
  for (const section of file.sections) {
    const key = section.name.toLowerCase();
    const plan = merged.get(key) ?? { name: section.name, collapsed: section.collapsed, existingId: existing.get(key) ?? null, repoIds: [], missing: 0 };
    for (const entry of section.repositories) {
      const repo = (entry.id !== null ? byId.get(entry.id) : undefined) ?? (entry.fullName ? byName.get(entry.fullName.toLowerCase()) : undefined);
      if (!repo) plan.missing++;
      else if (!used.has(repo.id)) {
        used.add(repo.id);
        plan.repoIds.push(repo.id);
      }
    }
    merged.set(key, plan);
  }
  return [...merged.values()];
}

/** Turns suggestions (already filtered and renamed by the user) into a plan the same way an import would. */
export function planSections(sections: { name: string; collapsed: boolean; repoIds: RepoId[] }[], layout: Layout): PlanSection[] {
  const existing = existingByName(layout);
  const merged = new Map<string, PlanSection>();
  for (const s of sections) {
    const name = cleanSectionName(s.name);
    if (!name || !s.repoIds.length) continue;
    const key = name.toLowerCase();
    const plan = merged.get(key) ?? { name, collapsed: s.collapsed, existingId: existing.get(key) ?? null, repoIds: [], missing: 0 };
    for (const id of s.repoIds) if (!plan.repoIds.includes(id)) plan.repoIds.push(id);
    merged.set(key, plan);
  }
  return [...merged.values()];
}

/**
 * Operations for a plan: new sections go above Uncategorized in plan order, then repositories are appended in
 * order. Also returns what undo needs: the sections it created and every repository it moved.
 */
export function opsForPlan(plan: PlanSection[], makeId: () => string = newSectionId): { ops: LayoutOp[]; created: string[]; moved: RepoId[] } {
  const ops: LayoutOp[] = [];
  const created: string[] = [];
  const moved: RepoId[] = [];
  const targets: { id: string; plan: PlanSection }[] = [];
  for (const section of plan) {
    if (!section.repoIds.length) continue;
    let id = section.existingId;
    if (!id) {
      id = makeId();
      created.push(id);
      ops.push({ type: 'createSection', sectionId: id, name: section.name, beforeSectionId: UNCATEGORIZED_ID });
      if (section.collapsed) ops.push({ type: 'setCollapsed', sectionId: id, collapsed: true });
    }
    targets.push({ id, plan: section });
  }
  for (const { id, plan: section } of targets) {
    for (const repoId of section.repoIds) {
      ops.push({ type: 'moveRepo', repoId, toSectionId: id, beforeRepoId: null });
      moved.push(repoId);
    }
  }
  return { ops, created, moved };
}

/** Splits operations into requests the background accepts (it caps one request at 500 operations). */
export function chunkOps(ops: LayoutOp[], size = 500): LayoutOp[][] {
  const chunks: LayoutOp[][] = [];
  for (let i = 0; i < ops.length; i += size) chunks.push(ops.slice(i, i + size));
  return chunks;
}
