import { describe, expect, it } from 'vitest';
import {
  HEAD_KEY,
  SYNC_ITEM_QUOTA,
  SyncQuotaError,
  TOTAL_BUDGET,
  chromeJsonBytes,
  chunkKey,
  decodeSyncItems,
  encodeLayout,
  itemBytes,
  layoutToPayload,
  staleChunkKeys,
  writeSchemaFor,
} from '../../src/shared/layout/codec';
import { MIGRATIONS, MigrationError, migratePayload } from '../../src/shared/layout/migrations';
import { UNCATEGORIZED_ID, emptyLayout, normalizeLayout } from '../../src/shared/layout/model';
import type { Layout } from '../../src/shared/types';

function bigLayout(repoCount: number, sectionName = 'Section', perSection = 50): Layout {
  const sections = [];
  for (let s = 0; s * perSection < repoCount; s++) {
    const ids = [];
    for (let i = s * perSection; i < Math.min(repoCount, (s + 1) * perSection); i++) ids.push(800_000_000 + i * 104_729);
    sections.push({ id: `sec${s}`, name: `${sectionName} ${s}`, collapsed: s % 2 === 0, repoIds: ids });
  }
  return normalizeLayout({ sections, extra: {} });
}

describe('sync codec', () => {
  it('round-trips a small layout in a single atomic head item', () => {
    const layout = bigLayout(120, 'Wörk 😀 "quoted" \\ back');
    const encoded = encodeLayout(layout, { rev: 'rev1', now: 1_700_000_000_000 });
    expect(encoded.chunkCount).toBe(1);
    expect(Object.keys(encoded.items)).toEqual([HEAD_KEY]);
    const decoded = decodeSyncItems(encoded.items);
    expect(decoded.status).toBe('ok');
    if (decoded.status === 'ok') expect(decoded.layout).toEqual(layout);
  });

  it('chunks large layouts within the per-item quota, measured in UTF-8 bytes, without splitting code points', () => {
    const layout = bigLayout(3000, '日本語セクション😀');
    const encoded = encodeLayout(layout, { rev: 'rev2', now: 1 });
    expect(encoded.chunkCount).toBeGreaterThan(1);
    for (const [key, value] of Object.entries(encoded.items)) {
      expect(itemBytes(key, value)).toBeLessThanOrEqual(SYNC_ITEM_QUOTA);
      if (key !== HEAD_KEY) expect(value as string).toMatch(/^rev2\|/);
      // A lone surrogate would show up as an escaped \ud8xx sequence after stringification.
      expect(JSON.stringify(value)).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
    }
    expect(encoded.bytes).toBeLessThanOrEqual(TOTAL_BUDGET);
    const decoded = decodeSyncItems(encoded.items);
    expect(decoded.status).toBe('ok');
    if (decoded.status === 'ok') expect(decoded.layout).toEqual(layout);
  });

  it('sizes items the way Chrome does, so names full of "<" never exceed the per-item quota', () => {
    const sections = Array.from({ length: 120 }, (_, i) => ({ id: `s${i}`, name: '<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<', collapsed: false, repoIds: [800_000_000 + i] }));
    const layout = normalizeLayout({ sections, extra: {} });
    const encoded = encodeLayout(layout, { rev: 'lt', now: 1_759_300_000_000 });
    for (const [key, value] of Object.entries(encoded.items)) expect(itemBytes(key, value)).toBeLessThanOrEqual(SYNC_ITEM_QUOTA);
    expect(chromeJsonBytes('<')).toBe(8); // "\u003C"
    expect(chromeJsonBytes(1_759_300_000_000)).toBe(15); // written as 1759300000000.0
    expect(chromeJsonBytes(42)).toBe(2);
    const decoded = decodeSyncItems(encoded.items);
    expect(decoded.status === 'ok' && decoded.layout.sections[0]!.name).toBe(sections[0]!.name);
  });

  it('stays compact: 1,000 assigned repositories fit in a few items', () => {
    const encoded = encodeLayout(bigLayout(1000), { rev: 'r', now: 1 });
    expect(encoded.bytes).toBeLessThan(12_000);
  });

  it('refuses layouts above the total sync budget instead of writing a partial document', () => {
    const huge = bigLayout(20_000, 'Section', 200);
    expect(huge.sections.flatMap((s) => s.repoIds)).toHaveLength(20_000);
    expect(() => encodeLayout(huge, { rev: 'r', now: 1 })).toThrow(SyncQuotaError);
    // The largest supported layout (about 10,000 assigned repositories) still fits.
    expect(encodeLayout(bigLayout(10_000, 'Section', 100), { rev: 'r', now: 1 }).bytes).toBeLessThanOrEqual(TOTAL_BUDGET);
  });

  it('detects partially delivered writes (mixed revisions) and missing chunks', () => {
    const first = encodeLayout(bigLayout(3000), { rev: 'aaaa', now: 1 });
    const second = encodeLayout(bigLayout(3000, 'Other'), { rev: 'bbbb', now: 2 });
    const mixed = { ...first.items, [HEAD_KEY]: second.items[HEAD_KEY] };
    expect(decodeSyncItems(mixed)).toMatchObject({ status: 'inconsistent' });
    const missing = { ...first.items };
    delete missing[chunkKey(1)];
    expect(decodeSyncItems(missing)).toMatchObject({ status: 'inconsistent' });
    expect(decodeSyncItems({ [chunkKey(1)]: 'x|y' })).toMatchObject({ status: 'inconsistent' });
    expect(decodeSyncItems({})).toEqual({ status: 'empty' });
  });

  it('reports corrupt heads and payloads without throwing', () => {
    expect(decodeSyncItems({ [HEAD_KEY]: { v: 'x' } })).toMatchObject({ status: 'corrupt' });
    expect(decodeSyncItems({ [HEAD_KEY]: { v: 1, c: 1, n: 1, r: 'r', t: 1, d: '{not json' } })).toMatchObject({ status: 'corrupt' });
    expect(decodeSyncItems({ [HEAD_KEY]: { v: 1, c: 1, n: 1, r: 'r', t: 1, d: '{"s":5}' } })).toMatchObject({ status: 'corrupt' });
  });

  it('lists stale chunk keys after a layout shrinks', () => {
    expect(staleChunkKeys(['grn:h', 'grn:1', 'grn:2', 'grn:3', 'other'], 2)).toEqual(['grn:2', 'grn:3']);
    expect(staleChunkKeys(['grn:1'], 1)).toEqual(['grn:1']);
  });

  it('encodes IDs in base36 and omits the Uncategorized name', () => {
    const layout = normalizeLayout({ sections: [{ id: 'a', name: 'A', collapsed: false, repoIds: [36, 1296] }], extra: {} });
    expect(layoutToPayload(layout)).toEqual({ s: [['a', 'A', 0, '10,100'], [UNCATEGORIZED_ID, '', 0, '']] });
  });
});

describe('schema versions and migrations', () => {
  const futureItems = (v: number, c: number) => {
    const payload = { s: [['a', 'Work', 0, 'abc', { color: 'red' }], [UNCATEGORIZED_ID, '', 1, '']], favorites: 'abc', layoutMode: 'grid' };
    return { [HEAD_KEY]: { v, c, n: 1, r: 'f', t: 5, d: JSON.stringify(payload) } };
  };

  it('edits a newer but compatible document and passes unknown fields through verbatim', () => {
    const decoded = decodeSyncItems(futureItems(2, 1));
    expect(decoded.status).toBe('ok');
    if (decoded.status !== 'ok') return;
    expect(decoded.layout.extra).toEqual({ favorites: 'abc', layoutMode: 'grid' });
    expect(decoded.layout.sections[0]!.extra).toEqual([{ color: 'red' }]);
    const schema = writeSchemaFor(decoded.head);
    expect(schema).toEqual({ v: 2, c: 1 });
    const reencoded = encodeLayout(decoded.layout, { rev: 'g', now: 6, schema });
    const again = decodeSyncItems(reencoded.items);
    expect(again.status).toBe('ok');
    if (again.status === 'ok') expect(again.layout).toEqual(decoded.layout);
    expect((reencoded.items[HEAD_KEY] as { v: number }).v).toBe(2);
  });

  it('treats an incompatible newer document as read-only and still renders it', () => {
    const decoded = decodeSyncItems(futureItems(3, 3));
    expect(decoded.status).toBe('readonly');
    if (decoded.status === 'readonly') {
      expect(decoded.layout?.sections[0]).toMatchObject({ id: 'a', name: 'Work' });
      expect(decoded.reason).toMatch(/newer version/);
    }
    expect(writeSchemaFor({ v: 3, c: 3 })).toEqual({ v: 1, c: 1 });
  });

  it('runs ordered migrations deterministically and fails loudly on a gap', () => {
    const registry = {
      1: (p: Record<string, unknown>) => ({ ...p, step1: true, order: [...((p.order as string[]) ?? []), 'v1->v2'] }),
      2: (p: Record<string, unknown>) => ({ ...p, order: [...(p.order as string[]), 'v2->v3'] }),
    };
    const input = { s: [] };
    const a = migratePayload(input, 1, 3, registry);
    const b = migratePayload(input, 1, 3, registry);
    expect(a).toEqual({ s: [], step1: true, order: ['v1->v2', 'v2->v3'] });
    expect(b).toEqual(a);
    expect(input).toEqual({ s: [] }); // input untouched
    expect(() => migratePayload(input, 1, 4, registry)).toThrow(MigrationError);
    expect(() => migratePayload(input, 0, 1, registry)).toThrow(MigrationError);
    expect(Object.keys(MIGRATIONS)).toEqual([]); // v1 is the first released schema
  });

  it('migrates an older document through the decode path when a migration exists', () => {
    const items = { [HEAD_KEY]: { v: 1, c: 1, n: 1, r: 'o', t: 1, d: JSON.stringify({ sections: [{ id: 'a', title: 'Old' }] }) } };
    const decoded = decodeSyncItems(items, 2);
    // No 1->2 migration is registered in this build, so it must refuse (corrupt) rather than guess.
    expect(decoded).toMatchObject({ status: 'corrupt' });
  });

  it('round-trips the empty layout', () => {
    const encoded = encodeLayout(emptyLayout(), { rev: 'e', now: 1 });
    const decoded = decodeSyncItems(encoded.items);
    expect(decoded).toMatchObject({ status: 'ok' });
  });
});
