import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What ends a step-up window (post-Build-4, the owner's requirement of 2026-11-03), beside the behaviour proven in
 * platform-mfa.service.spec.ts (expiry, sign-out, revocation, a disabled administrator, a new authenticator):
 *
 * - **A password change.** An administrator's password is set in exactly two places: the server CLI's reset
 *   (`prisma/create-platform-admin.ts`), which revokes every session and its window in the same run, and an invited
 *   administrator's setup, which happens before that administrator is `active` — and a window needs an active one.
 * - **An authenticator change.** Only the server's enrolment token resets a factor, and it revokes every session.
 * - **A role or permission change.** Platform administrators have none: one role, so nothing to change. Their state
 *   (`active`, disabled, deleted) is read on every check, so any change to it ends the window at the next request.
 */
const ROOT = join(__dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

describe('what ends a step-up window, by construction', () => {
  it('the CLI password reset revokes every session of that administrator, and their window, after the new password', () => {
    const cli = read('prisma', 'create-platform-admin.ts');
    const reset = cli.indexOf('data: { passwordHash, name, isActive: true, deletedAt: null }');
    const revoke = cli.indexOf('platformAdminSession.updateMany', reset);
    expect(reset).toBeGreaterThan(0);
    expect(revoke).toBeGreaterThan(reset);
    expect(cli.slice(revoke, revoke + 300)).toMatch(/revokedAt: new Date\(\), stepUpAt: null/);
  });

  it('no other code writes an administrator’s password but the invitation setup, which an active administrator never goes through', () => {
    const writers = ['src/platform/platform-admin-invitation.service.ts', 'src/platform/platform-admin.service.ts', 'src/platform/platform-mfa.service.ts', 'src/platform/platform.controller.ts'];
    for (const f of writers) {
      const s = read(f);
      const updates = [...s.matchAll(/platformAdmin\.update(Many)?\(\{[\s\S]{0,400}?passwordHash/g)];
      if (f.endsWith('platform-admin-invitation.service.ts')) expect(updates.length).toBeGreaterThan(0);
      else expect({ f, updates: updates.length }).toEqual({ f, updates: 0 });
    }
    expect(read('src/platform/platform-admin-invitation.service.ts')).toMatch(/adminState: \{ in: \['invited', 'enrolling'\] \}/);
  });

  it('the window is honoured only for an active, undeleted administrator on a live, verified session — read on every check', () => {
    const mfa = read('src/platform/platform-mfa.service.ts');
    expect(mfa).toMatch(/!session\.revokedAt && session\.expiresAt > now && !!session\.mfaVerifiedAt && !!admin\?\.isActive && !admin\.deletedAt && admin\.adminState === 'active'/);
    // A factor reset revokes every session, and with them their windows.
    expect(mfa).toMatch(/issueEnrolmentToken[\s\S]*platformAdminSession\.updateMany\(\{ where: \{ adminId: admin\.id, revokedAt: null \}, data: \{ revokedAt: now, stepUpAt: null \} \}\)/);
  });

  it('administrators have no role or permission to change', () => {
    const schema = read('prisma', 'schema.prisma');
    const model = schema.slice(schema.indexOf('model PlatformAdmin {'), schema.indexOf('}', schema.indexOf('model PlatformAdmin {')));
    expect(model).not.toMatch(/\brole|permission/i);
  });
});
