/**
 * Sync payload schema versions.
 *
 * CURRENT_SCHEMA is what this build writes. COMPAT_SCHEMA is the oldest schema that can read AND write a
 * CURRENT_SCHEMA document without losing information; it is stored in the document head as `c`. A future
 * version that only adds fields keeps `c` unchanged, so older devices keep editing and pass unknown fields
 * through. A future version that changes meaning bumps `c`, and older devices switch to read-only instead of
 * overwriting it.
 */
export const CURRENT_SCHEMA = 1;
export const COMPAT_SCHEMA = 1;

/** A migration turns a raw payload of version N into a raw payload of version N + 1. Pure and deterministic. */
export type Migration = (payload: Record<string, unknown>) => Record<string, unknown>;

/**
 * MIGRATIONS[n] upgrades version n to n + 1. Version 1 is the first released schema, so the table is empty;
 * the next schema adds `MIGRATIONS[1]` and bumps CURRENT_SCHEMA.
 */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {};

export class MigrationError extends Error {}

export function migratePayload(
  payload: Record<string, unknown>,
  fromVersion: number,
  toVersion: number = CURRENT_SCHEMA,
  migrations: Readonly<Record<number, Migration>> = MIGRATIONS,
): Record<string, unknown> {
  if (!Number.isInteger(fromVersion) || fromVersion < 1) throw new MigrationError(`Unknown schema version ${String(fromVersion)}.`);
  if (fromVersion > toVersion) throw new MigrationError(`Cannot downgrade schema ${fromVersion} to ${toVersion}.`);
  let current = structuredClone(payload);
  for (let v = fromVersion; v < toVersion; v++) {
    const step = migrations[v];
    if (!step) throw new MigrationError(`No migration from schema ${v} to ${v + 1}.`);
    current = step(current);
  }
  return current;
}
