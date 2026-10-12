import { randomBytes } from 'node:crypto';
import { base32Encode } from './totp';

/**
 * Recovery codes for an administrator who has lost the authenticator (correction phase, 2026-10-12): ten, shown
 * once, each usable once, stored only as a keyed digest. Generating a new set invalidates the old one.
 *
 * `XXXXX-XXXXX`: ten base32 characters, 50 random bits each — far beyond guessing within the lockout.
 */
export const RECOVERY_CODE_COUNT = 10;

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

/** As typed: case, spaces and dashes do not matter. */
export function normaliseRecoveryCode(text: string): string {
  return (text ?? '').toUpperCase().replace(/[\s-]/g, '');
}

export function looksLikeRecoveryCode(text: string): boolean {
  return /^[A-Z2-7]{10}$/.test(normaliseRecoveryCode(text));
}
