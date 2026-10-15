import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterDto } from '../../platform/registration.dto';
import { ADMIN_KEY_PREFIX, CreateBusinessDto } from '../../platform/platform.controller';
import { ClaimTrialDto } from '../../platform/trial/trial.dto';
import { TRIAL_TERMS_VERSION } from '../../platform/trial/trial-rules';
import { IDEMPOTENCY_KEY_COLUMN } from './idempotency-key.decorator';

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

describe('the console’s key follows the same rule, and fits its column with the prefix it is stored under (C11)', () => {
  const console_ = (idempotencyKey: unknown) =>
    plainToInstance(CreateBusinessDto, { idempotencyKey, ownerName: 'Aicha', businessName: 'Boutique', language: 'fr', reason: 'Signed up by phone' });
  /** As many characters as the column leaves after `admin:`. */
  const room = IDEMPOTENCY_KEY_COLUMN - ADMIN_KEY_PREFIX.length;

  it('the prefix and the longest key it accepts fill the column exactly', () => {
    expect(room).toBe(74);
    expect((ADMIN_KEY_PREFIX + 'k'.repeat(room)).length).toBe(IDEMPOTENCY_KEY_COLUMN);
  });

  it.each([
    ['the website’s crypto.randomUUID()', randomUUID()],
    ['the release check’s', 'trial-http-console-r1'],
    ['a key with every allowed character', 'Az09._:-'],
    ['one character', 'k'],
    ['as long as the column leaves', 'k'.repeat(74)],
  ])('accepts %s', async (_name, key) => {
    expect(await keyProblems(console_(key))).toEqual([]);
  });

  it.each([
    ['empty', ''],
    // Stored as `admin:` + 75 characters, it would be cut to the column's 80 and never match its own retry.
    ['one character more than the column leaves', 'k'.repeat(75)],
    ['eighty characters', 'k'.repeat(80)],
    ['letters each followed by a variation selector', 'a️'.repeat(40)],
    ['an emoji', 'key-\u{1F600}'],
    ['a space', 'my key'],
    ['an address', 'ops@example.test'],
    ['not a string', 42],
  ])('refuses %s', async (_name, key) => {
    expect(await keyProblems(console_(key))).not.toEqual([]);
  });
});
