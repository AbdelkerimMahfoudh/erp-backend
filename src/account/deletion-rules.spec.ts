import { uuidToBin } from '../common/utils/uuid.util';
import {
  REQUEST_MAX_AGE_MS,
  UNUSABLE_PASSWORD_HASH,
  VERIFIED_PROOF_MAX_AGE_MS,
  deidentifiedLogin,
  deletionKindFor,
  isOpen,
  proofProblem,
  requestIsFresh,
} from './deletion-rules';
import { HashingService } from '../common/security/hashing.service';

/**
 * The rules of account deletion, tested as the pure functions they are
 * (docs/64 §2). What is decided here never comes from the client.
 */

const NOW = new Date('2026-09-30T12:00:00Z');
const C1 = uuidToBin('018f0000-0000-7000-8000-00000000c001');
const C2 = uuidToBin('018f0000-0000-7000-8000-00000000c002');
const U1 = uuidToBin('018f0000-0000-7000-8000-00000000a001');
const U2 = uuidToBin('018f0000-0000-7000-8000-00000000a002');
const CH = uuidToBin('018f0000-0000-7000-8000-00000000f001');
const OTHER_CH = uuidToBin('018f0000-0000-7000-8000-00000000f002');

const request = (over: Partial<Parameters<typeof proofProblem>[0]> = {}) => ({
  id: uuidToBin('018f0000-0000-7000-8000-00000000d001'),
  companyId: C1,
  userId: U1,
  status: 'confirmed' as const,
  challengeId: CH,
  ...over,
});

const challenge = (over: Partial<NonNullable<Parameters<typeof proofProblem>[1]>> = {}) => ({
  id: CH,
  companyId: C1,
  userId: U1,
  purpose: 'account_deletion' as const,
  status: 'verified' as const,
  verifiedAt: new Date(NOW.getTime() - 60_000),
  destination: '+22231234567',
  ...over,
});

describe('who closes the business', () => {
  it('the last active Owner closes it; anybody else deletes a login', () => {
    expect(deletionKindFor({ holdsOwnerRole: true, otherActiveOwners: 0 })).toBe('company_closure');
    expect(deletionKindFor({ holdsOwnerRole: true, otherActiveOwners: 1 })).toBe('personal_login');
    expect(deletionKindFor({ holdsOwnerRole: false, otherActiveOwners: 0 })).toBe('personal_login');
  });
});

describe('recent reauthentication has a number', () => {
  it('thirty minutes', () => {
    expect(REQUEST_MAX_AGE_MS).toBe(30 * 60 * 1000);
    expect(requestIsFresh(new Date(NOW.getTime() - REQUEST_MAX_AGE_MS), NOW)).toBe(true);
    expect(requestIsFresh(new Date(NOW.getTime() - REQUEST_MAX_AGE_MS - 1), NOW)).toBe(false);
  });
});

describe('what the executor accepts as proof', () => {
  it('a confirmed request with its own verified, fresh deletion challenge', () => {
    expect(proofProblem(request(), challenge(), NOW)).toBeNull();
  });

  it.each([
    ['awaiting_code', 'not confirmed'],
    ['processing', 'not confirmed'],
    ['completed', 'not confirmed'],
    ['cancelled', 'not confirmed'],
    ['failed', 'not confirmed'],
  ] as const)('never a request that is %s', (status, expected) => {
    // A status flipped by hand is not a confirmation: the executor still
    // needs the challenge, and a request that is not `confirmed` has no claim
    // on it.
    expect(proofProblem(request({ status }), challenge(), NOW)).toContain(expected);
  });

  it('never without a challenge', () => {
    expect(proofProblem(request({ challengeId: null }), null, NOW)).toContain('no challenge');
    expect(proofProblem(request(), null, NOW)).toContain('no challenge');
  });

  it("never somebody else's challenge, or another company's", () => {
    expect(proofProblem(request(), challenge({ id: OTHER_CH }), NOW)).toContain("not the request's");
    expect(proofProblem(request(), challenge({ userId: U2 }), NOW)).toContain('another user');
    expect(proofProblem(request(), challenge({ companyId: C2 }), NOW)).toContain('another company');
  });

  it('never a code issued for another purpose', () => {
    // A phone-verification or device code typed into the deletion screen must
    // not delete anything, even if it verified.
    for (const purpose of ['phone_verification', 'device_verification', 'logout_reauth', 'portal_handoff', 'registration_continuation'] as const) {
      expect(proofProblem(request(), challenge({ purpose }), NOW)).toContain(`purpose is ${purpose}`);
    }
  });

  it('never an unverified, pending, locked, expired or cancelled challenge', () => {
    for (const status of ['pending', 'locked', 'expired', 'cancelled'] as const) {
      expect(proofProblem(request(), challenge({ status }), NOW)).toContain('not verified');
    }
    expect(proofProblem(request(), challenge({ verifiedAt: null }), NOW)).toContain('not verified');
  });

  it('never a stale verification', () => {
    const old = new Date(NOW.getTime() - VERIFIED_PROOF_MAX_AGE_MS - 1);
    expect(proofProblem(request(), challenge({ verifiedAt: old }), NOW)).toContain('too old');
  });
});

describe('the de-identified login', () => {
  it('is derived from the id, so it is unique per company and carries nothing personal', () => {
    expect(deidentifiedLogin(U1)).toBe('deleted-018f000000007000800000000000a001');
    expect(deidentifiedLogin(U1)).not.toBe(deidentifiedLogin(U2));
  });

  it('keeps a password hash nothing verifies against', async () => {
    const hashing = new HashingService();
    expect(await hashing.verify(UNUSABLE_PASSWORD_HASH, '')).toBe(false);
    expect(await hashing.verify(UNUSABLE_PASSWORD_HASH, '$deleted$')).toBe(false);
    expect(await hashing.verify(UNUSABLE_PASSWORD_HASH, 'password')).toBe(false);
  });
});

describe('open and terminal', () => {
  it('names exactly the states a request can still move from', () => {
    expect(isOpen('awaiting_code')).toBe(true);
    expect(isOpen('confirmed')).toBe(true);
    expect(isOpen('processing')).toBe(true);
    expect(isOpen('completed')).toBe(false);
    expect(isOpen('cancelled')).toBe(false);
    expect(isOpen('failed')).toBe(false);
  });
});
