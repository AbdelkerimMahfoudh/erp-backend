import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterDto } from '../../platform/registration.dto';
import { ClaimTrialDto } from '../../platform/trial/trial.dto';
import { TRIAL_TERMS_VERSION } from '../../platform/trial/trial-rules';

/**
 * The claim's and the registration's idempotency keys (C11; review finding R2-5): 1 to 80 ASCII letters, digits and
 * `. _ : -`, validated as the global pipe validates — so every key that is accepted is stored exactly as sent, and a
 * retry with it replays. Anything else is a 400 before the service is reached.
 */

const PIPE = { whitelist: true, forbidNonWhitelisted: true } as const;

const claim = (idempotencyKey: unknown) => plainToInstance(ClaimTrialDto, { idempotencyKey, termsVersion: TRIAL_TERMS_VERSION });
const registration = (idempotencyKey: unknown) =>
  plainToInstance(RegisterDto, {
    idempotencyKey,
    ownerName: 'Aicha',
    businessName: 'Boutique Aicha',
    branchName: 'Main',
    email: 'aicha@example.test',
    password: 'password-1',
    language: 'en',
  });

async function keyProblems(dto: object): Promise<string[]> {
  const errors = await validate(dto, PIPE);
  return errors.filter((e) => e.property === 'idempotencyKey').flatMap((e) => Object.values(e.constraints ?? {}));
}

/** The app's own generator (erp-mobile lib/utils.ts `uuidv4`), as it builds a key. */
function appUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

describe('an idempotency key is stored exactly as it was sent (C11)', () => {
  it.each([
    ['the website’s crypto.randomUUID()', randomUUID()],
    ['the app’s uuidv4()', appUuid()],
    ['the QA script’s', 'qa-boutique-12'],
    ['a key with every allowed character', 'Az09._:-'],
    ['one character', 'k'],
    ['eighty characters', 'k'.repeat(80)],
  ])('accepts %s', async (_name, key) => {
    expect(await keyProblems(claim(key))).toEqual([]);
    expect(await keyProblems(registration(key))).toEqual([]);
  });

  it.each([
    ['empty', ''],
    ['eighty-one characters', 'k'.repeat(81)],
    // Each counts as one character to a length check and two to MySQL: the stored key would be cut.
    ['eighty letters each followed by a variation selector', 'a️'.repeat(80)],
    ['an emoji', 'key-\u{1F600}'],
    ['a space', 'my key'],
    ['an address', 'staging-fixture-store@test.com'],
    ['not a string', 42],
  ])('refuses %s, on the claim and on the registration', async (_name, key) => {
    expect(await keyProblems(claim(key))).not.toEqual([]);
    expect(await keyProblems(registration(key))).not.toEqual([]);
  });
});
