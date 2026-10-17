import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrationsOnDisk, missingMigrations } from './migrations-on-disk';

describe('readiness: the migrations this build carries against the ones the database finished', () => {
  it('lists the carried migrations in order, ignoring anything that is not a migration directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
    for (const name of ['0002_b', '0001_a']) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, 'migration.sql'), '-- sql');
    }
    mkdirSync(join(dir, 'not_a_migration'));
    writeFileSync(join(dir, 'migration_lock.toml'), 'provider = "mysql"');
    expect(migrationsOnDisk(dir)).toEqual(['0001_a', '0002_b']);
  });

  it('is null where the build carries no migrations, so nothing is expected', () => {
    expect(migrationsOnDisk(join(tmpdir(), 'no-such-dir-for-readiness'))).toBeNull();
    expect(missingMigrations(null, [])).toEqual([]);
  });

  it('names a carried migration the database has not finished: an image newer than its schema is not ready', () => {
    expect(missingMigrations(['0001_a', '0002_b', '0003_c'], ['0001_a', '0002_b'])).toEqual(['0003_c']);
    expect(missingMigrations(['0001_a'], ['0001_a', '0000_older_than_the_build'])).toEqual([]);
  });

  it('the repository itself: every carried migration is found', () => {
    const real = migrationsOnDisk(join(__dirname, '..', '..', 'prisma', 'migrations'));
    expect(real).not.toBeNull();
    expect(real!.length).toBeGreaterThan(90);
    expect(real![0]).toMatch(/^0001_/);
  });
});
