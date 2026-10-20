import type { StorageAreaLike } from './layoutStore';

/**
 * A storage area seen through a key prefix, so code written for one account (the auth, inventory and layout
 * stores, which use fixed key names) can keep one account's data apart from another's. Keys are read and written
 * as `${prefix}${key}`, and a whole-area read returns only this prefix's keys, with the prefix removed.
 *
 * The empty prefix is the area itself. The synced layout of the first account keeps it, so browsers still on an
 * older version keep reading and writing the same document.
 */
export function namespaced(area: StorageAreaLike, prefix: string): StorageAreaLike {
  if (!prefix) return area;
  const full = (keys: string | string[]) => (Array.isArray(keys) ? keys.map((k) => prefix + k) : prefix + keys);
  return {
    async get(keys) {
      const items = await area.get(keys === null || keys === undefined ? null : full(keys));
      return Object.fromEntries(Object.entries(items).flatMap(([key, value]) => (key.startsWith(prefix) ? [[key.slice(prefix.length), value]] : [])));
    },
    set: (items) => area.set(Object.fromEntries(Object.entries(items).map(([key, value]) => [prefix + key, value]))),
    remove: (keys) => area.remove(full(keys)),
  };
}

/** The keys of a change event that belong to `prefix`, with the prefix removed (all of them for the empty prefix). */
export function ownKeys(prefix: string, keys: readonly string[]): string[] {
  return prefix ? keys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)) : [...keys];
}

/** Every key in `area` under `prefix` (whole names), for removing an account's data from this device. */
export async function keysUnder(area: StorageAreaLike, prefix: string): Promise<string[]> {
  return Object.keys(await area.get(null)).filter((k) => k.startsWith(prefix));
}
