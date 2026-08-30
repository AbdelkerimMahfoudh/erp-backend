import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isValidImei, luhnValid } from '../inventory/imei.util';

/**
 * The retained staging fixture, and the things it must never do.
 *
 * It writes to a shared database and it holds a password somebody chose out
 * loud, so the interesting properties are all about restraint: it refuses
 * outside staging, it refuses to adopt an account it did not create, it writes
 * nothing without being asked twice, and running it again is a no-op.
 *
 * Source-level, deliberately: importing it would boot a Nest context and
 * connect to a database, and the properties that matter here are structural.
 */
describe('the staging fixture command is safe by default', () => {
  const source = readFileSync(
    join(__dirname, '..', '..', 'scripts', 'staging-fixture-store.ts'),
    'utf8',
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('writes nothing unless --apply is given', () => {
    expect(code).toMatch(/const APPLY = process\.argv\.includes\('--apply'\)/);
    /*
     * Every write sits behind a dry-run guard. Counted rather than measured by
     * proximity: the guards moved when the unit matching was restructured, and
     * a distance-based assertion fails on a refactor while proving nothing
     * about the guard itself.
     */
    expect((code.match(/!APPLY|if \(APPLY/g) ?? []).length).toBeGreaterThanOrEqual(4);
    for (const write of [
      'registration.register(',
      'prisma.product.create',
      'prisma.unit.create',
      'prisma.unit.update',
      'tacCatalog.upsert',
    ]) {
      const at = code.indexOf(write);
      expect([write, at > -1]).toEqual([write, true]);
      // Something already refused to proceed in dry run before this line.
      expect(code.slice(0, at)).toMatch(/if \(!APPLY\)|if \(APPLY\)/);
    }
  });

  it('refuses anything that is not unmistakably staging', () => {
    expect(code).toMatch(/APP_ENV/);
    expect(code).toMatch(/stag\(e\|ing\)/);
    expect(code).toMatch(/\^phonestore\$/i);
    expect(code).toMatch(/prod/);
    expect(code).toMatch(/demo/);
  });

  it('loads the staging environment with the override that makes it stick', () => {
    expect(source).toMatch(/loadEnv\(\{ path: '\.env\.staging', override: true \}\)/);
    // And before anything that might read a connection string.
    expect(source.indexOf('loadEnv(')).toBeLessThan(source.indexOf("from '../src/prisma"));
  });

  it('never contains the password, and never prints one', () => {
    /*
     * The whole reason this reads an environment variable. A staging password
     * in a tracked file is a staging password in every clone of the repository.
     */
    expect(code).toMatch(/process\.env\.FIXTURE_OWNER_PASSWORD/);
    expect(code).not.toMatch(/admin123/);
    expect(code).not.toMatch(/password\s*=\s*['"][^'"]+['"]/);
    // No console line anywhere carries the variable holding it.
    for (const line of code.split('\n').filter((l) => l.includes('console.log'))) {
      expect(line).not.toMatch(/password/i);
    }
  });

  it('refuses to take over an account it did not create', () => {
    // The single most dangerous thing a fixture command could do on a shared
    // database: adopt somebody else's Owner and grant it a subscription.
    expect(code).toMatch(/existingOwner\.company\.name !== COMPANY_NAME/);
    expect(code).toMatch(/will not take over an account it did not create/);
  });

  it('recognises its own work rather than making a second shop', () => {
    expect(code).toMatch(/already present, reusing/);
    // Products and units are both looked up before they are created.
    expect(code.indexOf('prisma.product.findFirst')).toBeLessThan(code.indexOf('prisma.product.create'));
    expect(code.indexOf('prisma.unit.findFirst')).toBeLessThan(code.indexOf('prisma.unit.create'));
    // And the grant is not stacked on an already-active subscription.
    expect(code).toMatch(/subscription\.status !== 'activated'/);
  });

  it('goes through the services that own each invariant', () => {
    /*
     * Roles, permission mappings, the branch and the pending subscription are
     * created by `RegistrationService`; the grant is recorded and audited by
     * `SubscriptionLifecycleService`. Writing either by hand would produce a
     * shop that looks right and has no audit trail behind it.
     */
    expect(code).toMatch(/registration\.register\(/);
    expect(code).toMatch(/lifecycle\.activateByGrant\(/);
    expect(code).toMatch(/continuation\.complete\(/);
    // No shortcut around them.
    expect(code).not.toMatch(/prisma\.role\.create/);
    expect(code).not.toMatch(/prisma\.rolePermission\.create/);
    expect(code).not.toMatch(/prisma\.subscription\.update/);
    // Reading it is fine; WRITING it would bypass the verification it records.
    expect(code).not.toMatch(/data: {[^}]*emailVerifiedAt/);
  });

  it('fabricates no payment, no trial and no trading history', () => {
    expect(code).not.toMatch(/subscriptionPayment/);
    expect(code).not.toMatch(/trial/i);
    for (const table of ['sale', 'expense', 'customer']) {
      expect(code).not.toMatch(new RegExp(`prisma\\.${table}\\.create`));
    }
  });

  it('revokes the session its own verification created', () => {
    // Completing a verification issues a real session. A fixture is a shop to
    // sign into later, not a live session left open on a shared host.
    expect(code).toMatch(/authSession\.updateMany/);
    expect(code).toMatch(/revokedAt: new Date\(\)/);
  });

  it('never disables a trigger or drops a constraint to get its way', () => {
    for (const forbidden of ['SET FOREIGN_KEY_CHECKS', 'DROP TRIGGER', 'TRUNCATE', '$executeRaw']) {
      expect(code).not.toContain(forbidden);
    }
  });
});

describe('the fixture IMEIs are synthetic, valid and unique', () => {
  /*
   * Regenerated here with the same rule the command uses, so this tests the
   * identifiers rather than a copy of them. No real device identifier is
   * involved: the TAC is not an allocated one.
   */
  const TEST_TAC = '01000000';

  const withCheckDigit = (fourteen: string): string => {
    for (let d = 0; d <= 9; d++) {
      const candidate = fourteen + String(d);
      if (luhnValid(candidate)) return candidate;
    }
    throw new Error('no check digit');
  };
  const imei = (index: number, secondary = false) =>
    withCheckDigit(TEST_TAC + String((secondary ? 500_000 : 100_000) + index).padStart(6, '0'));

  const primaries = Array.from({ length: 20 }, (_, i) => imei(i));
  const secondaries = Array.from({ length: 20 }, (_, i) => imei(i, true));

  it('every generated identifier passes the application validator', () => {
    for (const value of [...primaries, ...secondaries]) {
      expect([value, isValidImei(value)]).toEqual([value, true]);
    }
  });

  it('no primary equals any secondary, and none repeats', () => {
    const all = [...primaries, ...secondaries];
    expect(new Set(all).size).toBe(all.length);
    for (const p of primaries) expect(secondaries).not.toContain(p);
  });

  it('is deterministic, so a rerun provisions nothing new', () => {
    expect(Array.from({ length: 20 }, (_, i) => imei(i))).toEqual(primaries);
  });

  it('a near-valid IMEI is refused rather than stored', () => {
    // The negative case belongs in a test, never in inventory: flipping the
    // check digit must fail, or the validator is not doing anything.
    const good = primaries[0];
    const bad = good.slice(0, 14) + String((Number(good[14]) + 1) % 10);
    expect(isValidImei(good)).toBe(true);
    expect(isValidImei(bad)).toBe(false);
    expect(isValidImei(good.slice(0, 14))).toBe(false);
  });

  it('checks both columns before inserting, not just the primary one', () => {
    // An identifier that already exists as somebody's SECONDARY is just as
    // taken as one that exists as a primary.
    const code = readFileSync(
      join(__dirname, '..', '..', 'scripts', 'staging-fixture-store.ts'),
      'utf8',
    );
    // Both identifiers, against both columns, in one query.
    expect(code).toMatch(/const wanted = \[imei, \.\.\.\(imeiSecondary \? \[imeiSecondary\] : \[\]\)\]/);
    expect(code).toMatch(
      /wanted\.flatMap\(\(v\) => \[\{ imeiPrimary: v \}, \{ imeiSecondary: v \}\]\)/,
    );
    /*
     * And the fixture's OWN unit is not a clash with itself — it is the row
     * about to be corrected. Without that exclusion a rerun after the
     * identifiers changed would refuse its own work.
     */
    expect(code).toMatch(/NOT: \{ id: existing\.id \}/);
  });

  it('a dual-SIM phone is one unit with two identifiers, not two units', () => {
    const code = readFileSync(
      join(__dirname, '..', '..', 'scripts', 'staging-fixture-store.ts'),
      'utf8',
    );
    // One create per phone, carrying both columns.
    expect(code.match(/prisma\.unit\.create/g)?.length).toBe(1);
    expect(code).toMatch(/imeiPrimary: imei,\s*\n\s*imeiSecondary,/);
  });
});
