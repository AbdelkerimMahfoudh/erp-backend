import { WHATSAPP_CONSENT_VERSION } from '../messaging/whatsapp-consent';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { HashingService } from '../common/security/hashing.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { AccountSecurityService } from './account-security.service';
import { AccountService } from './account.service';

/**
 * Security and sign-in on real MySQL (D227). Codes go through a stand-in holding single use and purpose, so a code can be read
 * back; the real OTP service's own guards have their own specs. Everything else is real rows.
 */
const url = process.env.PROVISIONING_ROOT_URL;
const suite = url ? describe : describe.skip;
jest.setTimeout(120_000);

suite('changing how you sign in', () => {
  const root = url ? new PrismaClient({ datasources: { db: { url } } }) : (null as unknown as PrismaClient);
  const hashing = new HashingService();
  afterAll(() => root?.$disconnect());
  const hex = () => Buffer.from(randomUUID().replace(/-/g, ''), 'hex');
  const phoneNo = () => `+2224${Math.floor(Math.random() * 9e6 + 1e6)}`;

  function codes() {
    const sent: { id: string; to: string; code: string; used: boolean; purpose: string }[] = [];
    return {
      sent,
      canDeliverTo: () => true,
      request: async (r: { destination: string; purpose: string }) => {
        const id = randomUUID();
        sent.push({ id, to: r.destination, code: '123456', used: false, purpose: r.purpose });
        return { ok: true, challenge: { challengeId: id, delivered: true } };
      },
      verify: async ({ challengeId, code }: { challengeId: Buffer; code: string }) => {
        const row = sent.find((s) => s.id === binToUuid(challengeId));
        if (!row || row.used || row.code !== code) return { ok: false, reason: 'invalid_code' };
        row.used = true;
        return { ok: true, purpose: row.purpose };
      },
    };
  }

  async function world(emailOn = false) {
    const companyId = hex();
    const userId = hex();
    const sessionId = newUuidV7Bin();
    const otherSession = newUuidV7Bin();
    const t = randomUUID().replace(/-/g, '').slice(0, 12);
    const phone = phoneNo();
    await root.company.create({ data: { id: companyId, publicStoreId: t, currency: 'MRU', timezone: 'Africa/Nouakchott', settingsJson: {} } });
    await root.user.create({ data: { id: userId, companyId, name: 'Person', login: `l-${t}`, personalId: `U-${t.slice(0, 8)}`, passwordHash: await hashing.hash('old-password'), phone, phoneVerifiedAt: new Date() } as never });
    for (const id of [sessionId, otherSession]) {
      await root.authSession.create({ data: { id, companyId, userId, refreshTokenHash: 'x', expiresAt: new Date(Date.now() + 86400000) } as never });
    }
    const otp = codes();
    const email = { isEnabled: emailOn, send: jest.fn() };
    const contacts = { start: jest.fn(), latestChallengeFor: jest.fn(), confirmChallenge: jest.fn() };
    const records = { recordPending: jest.fn(), activatePending: jest.fn(), supersede: jest.fn() };
    const tokens = { generateRefreshSecret: () => 'new-secret', buildRefreshToken: (s: string, x: string) => `${s}.${x}` };
    const service = new AccountSecurityService(root as never, hashing, otp as never, contacts as never, tokens as never, records as never, email as never);
    return { p: { companyId, userId, sessionId }, otherSession, otp, email, records, service, phone };
  }
  type W = Awaited<ReturnType<typeof world>>;
  const user = (w: W) => root.user.findUniqueOrThrow({ where: { id: w.p.userId } });
  const code = (w: W) => w.otp.sent.at(-1)!.code;

  describe('the password', () => {
    it('needs the current password, then a code; then the old one is dead, other sessions end and this one rotates', async () => {
      const w = await world();
      await expect(w.service.startPassword(w.p as never, { currentPassword: 'wrong' })).rejects.toMatchObject({ response: { code: 'reauthentication_failed' } });
      expect(w.otp.sent).toHaveLength(0);

      const started = await w.service.startPassword(w.p as never, { currentPassword: 'old-password' });
      expect(w.otp.sent[0]).toMatchObject({ to: w.phone, purpose: 'credential_change' });
      expect(JSON.stringify(started)).not.toContain(w.phone);

      const done = await w.service.confirmPassword(w.p as never, { changeId: started.changeId, code: code(w), newPassword: 'a-new-password' });
      expect(done.refreshToken).toBe(`${binToUuid(w.p.sessionId)}.new-secret`);
      const after = await user(w);
      expect(await hashing.verify(after.passwordHash, 'a-new-password')).toBe(true);
      expect(await hashing.verify(after.passwordHash, 'old-password')).toBe(false);
      expect((await root.authSession.findUniqueOrThrow({ where: { id: w.otherSession } })).revokedAt).not.toBeNull();
      const mine = await root.authSession.findUniqueOrThrow({ where: { id: w.p.sessionId } });
      expect(mine.revokedAt).toBeNull();
      expect(await hashing.verify(mine.refreshTokenHash, 'new-secret')).toBe(true);
      const history = await w.service.history(w.p as never);
      expect(history.map((h) => h.event)).toContain('password_changed');
      // Audit rows say what happened, never a password or code.
      const rows = await root.auditLog.findMany({ where: { entityId: w.p.userId } });
      expect(JSON.stringify(rows.map((r) => [r.after, r.reason]))).not.toMatch(/a-new-password|old-password|123456/);
    });

    it('a used code, a wrong code and an expired change all fail, and the old password keeps working', async () => {
      const w = await world();
      const a = await w.service.startPassword(w.p as never, { currentPassword: 'old-password' });
      await expect(w.service.confirmPassword(w.p as never, { changeId: a.changeId, code: '000000', newPassword: 'a-new-password' })).rejects.toMatchObject({ response: { code: 'invalid_code' } });
      await w.service.confirmPassword(w.p as never, { changeId: a.changeId, code: code(w), newPassword: 'a-new-password' });
      await expect(w.service.confirmPassword(w.p as never, { changeId: a.changeId, code: code(w), newPassword: 'another-password' })).rejects.toMatchObject({ response: { code: 'invalid_code' } });
      expect(await hashing.verify((await user(w)).passwordHash, 'a-new-password')).toBe(true);

      const b = await w.service.startPassword(w.p as never, { currentPassword: 'a-new-password' });
      await root.credentialChange.update({ where: { id: uuidToBin(b.changeId) }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await expect(w.service.confirmPassword(w.p as never, { changeId: b.changeId, code: code(w), newPassword: 'third-password' })).rejects.toMatchObject({ response: { code: 'invalid_code' } });
      expect(await hashing.verify((await user(w)).passwordHash, 'a-new-password')).toBe(true);
    });

    it('refuses a short or unchanged password without spending the code', async () => {
      const w = await world();
      const a = await w.service.startPassword(w.p as never, { currentPassword: 'old-password' });
      await expect(w.service.confirmPassword(w.p as never, { changeId: a.changeId, code: code(w), newPassword: 'short' })).rejects.toMatchObject({ response: { code: 'password_weak' } });
      await expect(w.service.confirmPassword(w.p as never, { changeId: a.changeId, code: code(w), newPassword: 'old-password' })).rejects.toMatchObject({ response: { code: 'password_same' } });
      expect(w.otp.sent[0].used).toBe(false);
    });

    it('two confirmations at once: one wins', async () => {
      const w = await world();
      const a = await w.service.startPassword(w.p as never, { currentPassword: 'old-password' });
      const both = await Promise.allSettled([
        w.service.confirmPassword(w.p as never, { changeId: a.changeId, code: code(w), newPassword: 'first-password' }),
        w.service.confirmPassword(w.p as never, { changeId: a.changeId, code: code(w), newPassword: 'second-password' }),
      ]);
      expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });

    it('someone else’s change is not found', async () => {
      const [a, b] = [await world(), await world()];
      const started = await a.service.startPassword(a.p as never, { currentPassword: 'old-password' });
      await expect(b.service.confirmPassword(b.p as never, { changeId: started.changeId, code: '123456', newPassword: 'a-new-password' })).rejects.toMatchObject({ response: { code: 'invalid_code' } });
    });
  });

  describe('a WhatsApp number', () => {
    const start = (w: W, value: string) => w.service.startContact(w.p as never, { kind: 'phone', value, currentPassword: 'old-password', whatsappConsentVersion: WHATSAPP_CONSENT_VERSION });

    it('goes old channel first, then new, then swaps at once; the old number stops', async () => {
      const w = await world();
      const next = phoneNo();
      const s = await start(w, next);
      expect(w.otp.sent[0].to).toBe(w.phone);
      expect((await user(w)).phone).toBe(w.phone);

      await expect(w.service.confirmNew(w.p as never, { changeId: s.changeId, code: code(w) })).rejects.toMatchObject({ response: { code: 'invalid_code' } });
      await w.service.confirmOld(w.p as never, { changeId: s.changeId, code: code(w) });
      expect(w.otp.sent[1].to).toBe(next);
      expect((await user(w)).phone).toBe(w.phone);

      await w.service.confirmNew(w.p as never, { changeId: s.changeId, code: w.otp.sent[1].code });
      expect((await user(w)).phone).toBe(next);
      expect(w.records.supersede).toHaveBeenCalledTimes(1);
      expect((await root.authSession.findUniqueOrThrow({ where: { id: w.otherSession } })).revokedAt).not.toBeNull();
      expect((await root.authSession.findUniqueOrThrow({ where: { id: w.p.sessionId } })).revokedAt).toBeNull();
    });

    it('a number somebody else here holds looks the same until the end, and never tells them or changes anything', async () => {
      const w = await world();
      const taken = phoneNo();
      const t = randomUUID().replace(/-/g, '').slice(0, 8);
      await root.user.create({ data: { id: hex(), companyId: w.p.companyId, name: 'Other', login: `o-${t}`, personalId: `U-${t}`, passwordHash: 'x', phone: taken } as never });
      const s = await start(w, taken);
      const old = await w.service.confirmOld(w.p as never, { changeId: s.changeId, code: code(w) });
      expect(old).toMatchObject({ stage: 'new_channel' });
      expect(w.otp.sent.filter((c) => c.to === taken)).toHaveLength(0);
      await expect(w.service.confirmNew(w.p as never, { changeId: s.changeId, code: '123456' })).rejects.toMatchObject({ response: { code: 'invalid_code' } });
      expect((await user(w)).phone).toBe(w.phone);
    });

    it('an ended change keeps no contact: completed, cancelled, or superseded by the next one (privacy review)', async () => {
      const w = await world();
      const stored = async (changeId: string) => (await root.credentialChange.findUniqueOrThrow({ where: { id: uuidToBin(changeId) } })).newContact;
      const cancelled = await start(w, phoneNo());
      expect(await stored(cancelled.changeId)).not.toBeNull();
      await w.service.cancel(w.p as never, cancelled.changeId);
      expect(await stored(cancelled.changeId)).toBeNull();

      const abandoned = await start(w, phoneNo());
      const next = phoneNo();
      const done = await start(w, next);
      expect(await stored(abandoned.changeId)).toBeNull();
      await w.service.confirmOld(w.p as never, { changeId: done.changeId, code: w.otp.sent[w.otp.sent.length - 1].code });
      await w.service.confirmNew(w.p as never, { changeId: done.changeId, code: w.otp.sent[w.otp.sent.length - 1].code });
      expect((await user(w)).phone).toBe(next);
      expect(await stored(done.changeId)).toBeNull();
    });

    it('with no verified channel there is nothing to prove it with', async () => {
      const w = await world();
      await root.user.update({ where: { id: w.p.userId }, data: { phoneVerifiedAt: null } });
      await expect(start(w, phoneNo())).rejects.toMatchObject({ response: { code: 'no_verified_channel' } });
    });

    it('the old app’s route may no longer move a verified number, and still verifies a first one', async () => {
      const w = await world();
      const account = new AccountService(root as never, hashing, w.otp as never, {} as never, {} as never, undefined);
      await expect(account.startPhoneVerification(w.p as never, { phone: phoneNo(), password: 'old-password' })).rejects.toMatchObject({ response: { code: 'use_security_screen' } });
      await root.user.update({ where: { id: w.p.userId }, data: { phoneVerifiedAt: null } });
      await expect(account.startPhoneVerification(w.p as never, { phone: phoneNo(), password: 'old-password' })).rejects.not.toMatchObject({ response: { code: 'use_security_screen' } });
    });
  });

  describe('an email', () => {
    it('says it is unavailable before anything happens, and never pretends', async () => {
      const w = await world(false);
      await expect(w.service.startContact(w.p as never, { kind: 'email', value: 'new@example.test', currentPassword: 'old-password' })).rejects.toMatchObject({ response: { code: 'email_unavailable' } });
      expect(w.otp.sent).toHaveLength(0);
      expect((await user(w)).email).toBeNull();
      expect(w.service.capabilities()).toEqual({ emailChange: false });
    });
  });
});
