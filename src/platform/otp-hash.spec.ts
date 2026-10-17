import { otpHash, recoverOtp } from './otp-hash';

describe('the verification code hash, shared by the server and the staging retrieval command', () => {
  const pepper = 'p'.repeat(40);

  it('keys version 2 with the pepper and folds the destination in', () => {
    const v2 = otpHash('a@example.test', '012345', 2, pepper);
    expect(v2).not.toBe(otpHash('a@example.test', '012345', 1, null));
    expect(v2).not.toBe(otpHash('b@example.test', '012345', 2, pepper));
    expect(v2).not.toBe(otpHash('a@example.test', '012345', 2, 'q'.repeat(40)));
  });

  it('staging can recover a peppered code with the pepper, and only with it', () => {
    const hash = otpHash('+22236000001', '930417', 2, pepper);
    expect(recoverOtp('+22236000001', hash, 2, pepper)).toBe('930417');
    expect(recoverOtp('+22236000001', hash, 2, null)).toBeNull();
  });

  it('still recovers an older unkeyed code', () => {
    expect(recoverOtp('a@example.test', otpHash('a@example.test', '000123', 1, null), 1, null)).toBe('000123');
  });
});
