import { HttpException } from '@nestjs/common';
import { OtpService } from '../auth/otp/otp.service';
import { DisabledWhatsAppChannel, TestWhatsAppChannel } from '../messaging/channels';
import { AUTH_OTP_TEMPLATE } from '../messaging/templates';
import { uuidToBin } from '../common/utils/uuid.util';
import { FakePrisma } from '../account/testing/fake-prisma';
import { ActingOwnerStepUp, STEP_UP_PURPOSE, stepUpDigest, type StepUpAction } from './acting-owner-step-up';

/**
 * The Acting Owner's second factor (D225) on the REAL code service — the one account deletion uses — over the
 * in-memory database: the code goes to the Owner's verified WhatsApp number, is bound to one change, is spent once,
 * and the per-person send limit is the code service's own.
 */

const PEPPER = 'test-pepper-at-least-32-characters-long!!';
const id = (n: string) => uuidToBin(`018f0000-0000-7000-8000-${n.padStart(12, '0')}`);
const C1 = id('c001');
const OWNER = id('a001');
const NO_NUMBER = id('a002');
const DELEGATE = '018f0000-0000-7000-8000-00000000a003';
const OTHER = '018f0000-0000-7000-8000-00000000a004';

function harness(opts: { whatsappOff?: boolean } = {}) {
  const prisma = new FakePrisma() as FakePrisma & Record<string, any>;
  const channel = new TestWhatsAppChannel();
  const config = {
    otpPepper: PEPPER,
    otpTtlSeconds: 300,
    otpMaxAttempts: 5,
    otpResendCooldownSeconds: 60,
    otpMaxSendsPerWindow: 3,
    otpSendWindowSeconds: 900,
    otpMaxSendsPerDay: 10,
  };
  const otp = new OtpService(prisma as never, config as never, { record: jest.fn(async () => undefined) } as never, opts.whatsappOff ? new DisabledWhatsAppChannel() : channel);
  const stepUp = new ActingOwnerStepUp(prisma as never, otp);
  prisma.seed(
    'user',
    { id: OWNER, companyId: C1, phone: '+22231234567', phoneVerifiedAt: new Date('2026-09-01T00:00:00Z') },
    { id: NO_NUMBER, companyId: C1, phone: '+22231234568', phoneVerifiedAt: null },
  );
  const lastCode = () => channel.messages.filter((m) => m.template === AUTH_OTP_TEMPLATE.key).slice(-1)[0]?.variables.code as string;
  return { prisma, channel, stepUp, lastCode };
}

const appointUntilRevoked: StepUpAction = { action: 'appoint', delegateId: DELEGATE, startsAt: null, endsAt: null };
const code = (e: unknown) => ((e as HttpException).getResponse() as { code: string }).code;
const statusOf = (e: unknown) => (e as HttpException).getStatus();

describe('asking for the code', () => {
  it('sends one code, to the Owner’s verified WhatsApp number only, with the authentication template', async () => {
    const h = harness();
    const sent = await h.stepUp.request({ companyId: C1, userId: OWNER, change: appointUntilRevoked, language: 'ar' });
    expect(h.channel.messages).toHaveLength(1);
    expect(h.channel.last).toMatchObject({ to: '+22231234567', template: AUTH_OTP_TEMPLATE.key, language: 'ar' });
    expect(sent.destinationMasked).not.toContain('31234567');
    const row = await h.prisma.otpChallenge.findFirst({ where: { id: uuidToBin(sent.challengeId) } });
    expect(row).toMatchObject({ purpose: STEP_UP_PURPOSE });
    expect(String(row!.idempotencyKey)).toMatch(new RegExp(`^acting-owner:${stepUpDigest(appointUntilRevoked)}:`));
  });

  it('is refused without a verified number — nothing is sent anywhere else', async () => {
    const h = harness();
    const e = await h.stepUp.request({ companyId: C1, userId: NO_NUMBER, change: appointUntilRevoked }).catch((x: unknown) => x);
    expect([statusOf(e), code(e)]).toEqual([409, 'whatsapp_number_required']);
    expect(h.channel.messages).toHaveLength(0);
  });

  it('is refused when this server cannot send codes, and nothing is created', async () => {
    const h = harness({ whatsappOff: true });
    const e = await h.stepUp.request({ companyId: C1, userId: OWNER, change: appointUntilRevoked }).catch((x: unknown) => x);
    expect([statusOf(e), code(e)]).toEqual([503, 'step_up_unavailable']);
    expect(await h.prisma.otpChallenge.count({ where: {} })).toBe(0);
  });

  it('obeys the code service’s own per-person send limit (three in the window here)', async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) await h.stepUp.request({ companyId: C1, userId: OWNER, change: appointUntilRevoked });
    const e = await h.stepUp.request({ companyId: C1, userId: OWNER, change: appointUntilRevoked }).catch((x: unknown) => x);
    expect([statusOf(e), code(e)]).toEqual([429, 'too_many_codes']);
  });
});

describe('confirming with the code', () => {
  it('the right code for the same change passes, once', async () => {
    const h = harness();
    const sent = await h.stepUp.request({ companyId: C1, userId: OWNER, change: appointUntilRevoked });
    await expect(h.stepUp.confirm({ companyId: C1, userId: OWNER, change: appointUntilRevoked, challengeId: sent.challengeId, code: h.lastCode() })).resolves.toBe(sent.challengeId);
    const again = await h.stepUp.confirm({ companyId: C1, userId: OWNER, change: appointUntilRevoked, challengeId: sent.challengeId, code: h.lastCode() }).catch((x: unknown) => x);
    expect(code(again)).toBe('code_not_active');
  });

  it('a code asked for one change never confirms another (other person, other end, a removal)', async () => {
    const h = harness();
    const sent = await h.stepUp.request({ companyId: C1, userId: OWNER, change: appointUntilRevoked });
    const others: StepUpAction[] = [
      { action: 'appoint', delegateId: OTHER, startsAt: null, endsAt: null },
      { action: 'appoint', delegateId: DELEGATE, startsAt: null, endsAt: new Date('2026-11-05T23:59:59Z') },
      { action: 'revoke', delegationId: DELEGATE },
    ];
    for (const change of others) {
      const e = await h.stepUp.confirm({ companyId: C1, userId: OWNER, change, challengeId: sent.challengeId, code: h.lastCode() }).catch((x: unknown) => x);
      expect([statusOf(e), code(e)]).toEqual([409, 'code_not_active']);
    }
    // Still unspent: the right change goes through.
    await expect(h.stepUp.confirm({ companyId: C1, userId: OWNER, change: appointUntilRevoked, challengeId: sent.challengeId, code: h.lastCode() })).resolves.toBe(sent.challengeId);
  });

  it('a wrong code is counted, and the last attempt locks it', async () => {
    const h = harness();
    const sent = await h.stepUp.request({ companyId: C1, userId: OWNER, change: appointUntilRevoked });
    const wrong = h.lastCode() === '000000' ? '111111' : '000000';
    const first = await h.stepUp.confirm({ companyId: C1, userId: OWNER, change: appointUntilRevoked, challengeId: sent.challengeId, code: wrong }).catch((x: unknown) => x);
    expect([statusOf(first), code(first)]).toEqual([400, 'invalid_code']);
    expect(((first as HttpException).getResponse() as { attemptsRemaining: number }).attemptsRemaining).toBe(4);
    let last: unknown;
    for (let i = 0; i < 4; i++) last = await h.stepUp.confirm({ companyId: C1, userId: OWNER, change: appointUntilRevoked, challengeId: sent.challengeId, code: wrong }).catch((x: unknown) => x);
    expect(code(last)).toBe('code_locked');
    const after = await h.stepUp.confirm({ companyId: C1, userId: OWNER, change: appointUntilRevoked, challengeId: sent.challengeId, code: h.lastCode() }).catch((x: unknown) => x);
    expect(code(after)).toBe('code_locked');
  });

  it('a code sent to somebody else, or for another purpose, is not active here', async () => {
    const h = harness();
    const sent = await h.stepUp.request({ companyId: C1, userId: OWNER, change: appointUntilRevoked });
    const e = await h.stepUp.confirm({ companyId: C1, userId: NO_NUMBER, change: appointUntilRevoked, challengeId: sent.challengeId, code: h.lastCode() }).catch((x: unknown) => x);
    expect(code(e)).toBe('code_not_active');
    await h.prisma.otpChallenge.updateMany({ where: { id: uuidToBin(sent.challengeId) }, data: { purpose: 'phone_verification' } });
    const f = await h.stepUp.confirm({ companyId: C1, userId: OWNER, change: appointUntilRevoked, challengeId: sent.challengeId, code: h.lastCode() }).catch((x: unknown) => x);
    expect(code(f)).toBe('code_not_active');
  });
});
