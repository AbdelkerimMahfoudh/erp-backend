import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The NAMES of the migrations this build carries: the `<number>_<name>` directories of `prisma/migrations` beside the
 * running code (the image copies `prisma/` next to `dist/`). Only the names: the SQL is never opened, so it stays a
 * historical snapshot and never becomes runtime configuration (permission-catalogue.spec.ts, "the deployment
 * contract"). Null when there is no such directory, so readiness falls back to what the database alone can say rather
 * than inventing an expectation.
 */
export function migrationsOnDisk(dir = join(process.cwd(), 'prisma', 'migrations')): string[] | null {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+_/.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return null;
  }
}

/** The carried migrations the database has not finished: what keeps a deployment unready while its schema lags. */
export function missingMigrations(onDisk: readonly string[] | null, applied: readonly string[]): string[] {
  if (!onDisk) return [];
  const done = new Set(applied);
  return onDisk.filter((name) => !done.has(name));
}
