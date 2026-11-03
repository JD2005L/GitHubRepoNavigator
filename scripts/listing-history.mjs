// Which Chrome Web Store fields changed in which release, so SUBMIT.html can say exactly what to update in the
// dashboard. store/listing-history.json keeps one snapshot per packaged version: each field's content (as SUBMIT.md
// shows it, without notes) and, for images, a small grayscale thumbnail, compared with a tolerance because two
// renders of the same screen are rarely byte-identical.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fieldBody } from './submit-page.mjs';

/** The package changes with every release by definition (its version number). */
const ALWAYS_NEW = '1-upload-this.zip';
const IMAGE = /\.png$/i;
/**
 * Thumbnail size and how different two must be to count as a changed image (0-255 gray levels): re-renders of the
 * same screen differ by up to ~30 in a few cells (font hinting, antialiasing); a real change moves the average,
 * repaints whole cells, or shifts many cells a little (a small badge in a corner touched ~20-30 cells by more than
 * 16, where re-render noise touched at most 3).
 */
export const THUMB = { width: 64, height: 40 };
const BIG_CELL = 64;
const MAX_BIG_CELLS = 2;
const SOME_CELL = 16;
const MAX_SOME_CELLS = 8;
const MAX_MEAN = 2;

export const fieldKey = (tab, label) => `${tab} › ${label}`;

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export function readHistory(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { releases: [] };
}

export function writeHistory(path, history) {
  writeFileSync(path, `${JSON.stringify(history, null, 1)}\n`);
}

/** Every image a listing uploads (paths relative to the submission folder). */
export function imageFiles(tabs) {
  return tabs.flatMap((t) => t.fields.filter((f) => f.kind === 'file').flatMap((f) => f.files.filter((p) => IMAGE.test(p))));
}

/** One release's fields: { key: { kind, body, files?: { path: thumbnail } } }. */
export function snapshot(tabs, thumbs) {
  const fields = {};
  for (const tab of tabs) {
    for (const f of tab.fields) {
      fields[fieldKey(tab.tab, f.label)] = { kind: f.kind, body: fieldBody(f), ...(f.kind === 'file' ? { files: Object.fromEntries(f.files.map((p) => [p, thumbs[p] ?? null])) } : {}) };
    }
  }
  return fields;
}

/** The same snapshot read back from an earlier release's SUBMIT.md (used to seed the history). */
export function parseSubmitMarkdown(md, thumbs) {
  const fields = {};
  let tab = '';
  let current = null;
  const finish = () => {
    if (!current) return;
    const lines = current.lines;
    const fence = lines.indexOf('```text');
    let body;
    if (fence >= 0) body = lines.slice(fence + 1, lines.lastIndexOf('```')).join('\n');
    else body = lines.filter((l) => l.trim() && !l.startsWith('> ') && !/^_.*_$/.test(l)).join('\n');
    const uploads = lines.filter((l) => l.startsWith('- Upload `'));
    const files = uploads.length ? Object.fromEntries(uploads.map((l) => l.slice(10, -1)).map((p) => [p, thumbs[p] ?? null])) : undefined;
    fields[fieldKey(tab, current.label)] = { kind: fence >= 0 ? 'text' : files ? 'file' : 'other', body, ...(files ? { files } : {}) };
    current = null;
  };
  for (const line of md.split(/\r?\n/)) {
    const tabMatch = /^## \d+\. (.+) tab$/.exec(line);
    if (tabMatch) {
      finish();
      tab = tabMatch[1];
      continue;
    }
    const field = /^### (.+?)( \*)?$/.exec(line);
    if (field) {
      finish();
      current = { label: field[1], lines: [] };
      continue;
    }
    current?.lines.push(line);
  }
  finish();
  return fields;
}

/** Adds (or replaces) one release's snapshot, keeping releases in version order. */
export function record(history, version, fields) {
  const releases = history.releases.filter((r) => r.version !== version);
  releases.push({ version, fields });
  releases.sort((a, b) => compareVersions(a.version, b.version));
  return { releases };
}

function sameImage(a64, b64) {
  if (!a64 || !b64) return false;
  const a = Buffer.from(a64, 'base64');
  const b = Buffer.from(b64, 'base64');
  if (a.length !== b.length) return false;
  let total = 0;
  let big = 0;
  let some = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > BIG_CELL) big++;
    if (d > SOME_CELL) some++;
    total += d;
  }
  return big <= MAX_BIG_CELLS && some <= MAX_SOME_CELLS && total / a.length <= MAX_MEAN;
}

function sameFile(path, a, b) {
  if (path === ALWAYS_NEW) return false;
  return IMAGE.test(path) ? sameImage(a, b) : true;
}

function sameField(a, b) {
  if (!a || !b || a.body !== b.body) return false;
  return Object.entries(a.files ?? {}).every(([p, t]) => p in (b.files ?? {}) && sameFile(p, t, b.files[p]));
}

/**
 * For each field of `version`: the release it last changed in (walking back while it stayed the same), whether it
 * first appeared then, and the same for each of its files. Also each earlier release's text, for diffs.
 */
export function lineage(history, version) {
  const releases = history.releases.filter((r) => compareVersions(r.version, version) <= 0);
  const now = releases.at(-1);
  if (!now || now.version !== version) throw new Error(`No snapshot for ${version} in the listing history.`);
  const result = {};
  for (const [key, field] of Object.entries(now.fields)) {
    const back = (same) => {
      let since = version;
      for (let i = releases.length - 2; i >= 0; i--) {
        if (!same(releases[i].fields[key])) break;
        since = releases[i].version;
      }
      return since;
    };
    const since = back((old) => sameField(field, old));
    const files = Object.fromEntries(Object.entries(field.files ?? {}).map(([p, t]) => [p, back((old) => !!old?.files && p in old.files && sameFile(p, t, old.files[p]))]));
    const texts = field.kind === 'text' ? Object.fromEntries(releases.filter((r) => r.fields[key]).map((r) => [r.version, r.fields[key].body])) : undefined;
    const added = releases.find((r) => r.fields[key])?.version ?? version;
    result[key] = { since, added, files, ...(texts ? { texts } : {}) };
  }
  return { versions: releases.map((r) => r.version), fields: result };
}

/** Grayscale thumbnails (base64, THUMB.width x THUMB.height bytes) of the given images, drawn in a browser page. */
export async function thumbnails(browser, dir, files) {
  const page = await browser.newPage();
  const out = {};
  try {
    for (const p of files) {
      if (!existsSync(join(dir, p))) continue;
      const data = readFileSync(join(dir, p)).toString('base64');
      out[p] = await page.evaluate(
        async ({ data, width, height }) => {
          const img = new Image();
          img.src = `data:image/png;base64,${data}`;
          await img.decode();
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          const px = ctx.getImageData(0, 0, width, height).data;
          let bin = '';
          for (let i = 0; i < px.length; i += 4) bin += String.fromCharCode(Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]));
          return btoa(bin);
        },
        { data, ...THUMB },
      );
    }
  } finally {
    await page.close();
  }
  return out;
}
