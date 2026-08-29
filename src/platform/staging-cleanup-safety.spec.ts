import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The staging cleanup script, and the things it must never do.
 *
 * A cleanup script is run in a hurry, often in the wrong terminal, usually
 * because something else has already gone wrong. That is exactly when a
 * destructive default does its damage, so the guards are worth pinning even
 * though the file is tooling rather than product code.
 *
 * Source-level, deliberately: importing it would connect to a database, and the
 * properties that matter here are structural — the order of operations, the
 * default, and which references are released rather than deleted.
 */
describe('staging cleanup is safe by default', () => {
  const source = readFileSync(
    join(__dirname, '..', '..', 'scripts', 'staging-cleanup.ts'),
    'utf8',
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('deletes nothing unless --apply is given', () => {
    expect(code).toMatch(/const APPLY = process\.argv\.includes\('--apply'\)/);
    // Every destructive call is behind it.
    for (const call of ['company.delete', 'platformAdmin.deleteMany']) {
      const at = code.indexOf(call);
      expect(at).toBeGreaterThan(-1);
      expect(code.slice(Math.max(0, at - 400), at)).toMatch(/APPLY/);
    }
  });

  it('keeps the staging administrator unless asked to remove it', () => {
    // It is deliberate infrastructure, not test litter: sweeping it away meant
    // the next session had to recreate it before it could do anything.
    expect(code).toMatch(/const REMOVE_ADMIN = process\.argv\.includes\('--remove-admin'\)/);
    expect(code).toMatch(/if \(REMOVE_ADMIN\)/);
  });

  it('releases the audit reference instead of deleting the audit record', () => {
    /*
     * `platform_audit_events.admin_id` is a nullable FK with no delete action,
     * so it RESTRICTS — which is why this script used to fail outright. The
     * schema keeps the actor's name as text beside the reference precisely so
     * the record still reads once the admin row is gone, so the reference is
     * nulled and the event is KEPT.
     */
    const release = code.indexOf('platformAuditEvent.updateMany');
    const remove = code.indexOf('platformAdmin.deleteMany');
    expect(release).toBeGreaterThan(-1);
    expect(remove).toBeGreaterThan(-1);
    expect(release).toBeLessThan(remove);
    expect(code).toMatch(/data: \{ adminId: null \}/);
    // And never the other thing.
    expect(code).not.toMatch(/platformAuditEvent\.delete/);
  });

  it('revokes sessions before anything else', () => {
    // A live token outlives the row it authenticates and stays a working
    // credential until it expires on its own.
    const sessions = code.indexOf('platformAdminSession');
    const companies = code.indexOf('company.delete');
    expect(sessions).toBeGreaterThan(-1);
    expect(sessions).toBeLessThan(companies);
  });

  it('expires unspent continuations and handoff tickets', () => {
    // Both live in `verification_intents`, and both are credentials nobody is
    // watching once a test run ends.
    expect(code).toMatch(/verificationIntent\.updateMany/);
  });

  it('counts one company once, whatever its user count', () => {
    /*
     * `companyId` is a Buffer. A Set of Buffers dedupes by object identity, so
     * two users of one company produced two entries — the script over-reported
     * and would have tried to delete the same company twice.
     */
    expect(code).not.toMatch(/new Set\(\s*users\.filter/);
    expect(code).toMatch(/byHex\.set\(u\.companyId\.toString\('hex'\)/);
  });

  it('refuses anything that is not unmistakably staging', () => {
    expect(code).toMatch(/APP_ENV/);
    expect(code).toMatch(/\^phonestore\$/);
    expect(code).toMatch(/prod/);
    expect(code).toMatch(/demo/);
  });

  it('loads the staging environment with the override that makes it stick', () => {
    // `@prisma/client` loads `.env` as an import side effect, before this runs,
    // and plain dotenv will not replace a variable that is already set. Without
    // `override` the guard passes while the connection stays on development.
    expect(source).toMatch(/loadEnv\(\{ path: '\.env\.staging', override: true \}\)/);
  });

  it('never disables a trigger or drops a constraint to get its way', () => {
    for (const forbidden of ['SET FOREIGN_KEY_CHECKS', 'DROP TRIGGER', 'TRUNCATE', 'DROP TABLE']) {
      expect(code).not.toContain(forbidden);
    }
  });
});
