import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ActivityRequestDto, QuoteDto, StoreRequestDto } from './seat-requests.controller';
import { CreateBusinessDto, PlanVersionDto, RegisterDto } from './platform.controller';

/**
 * What the subscription routes accept (D154): an activity is one of three
 * words, a plan version prices all three, and nothing a client sends is an
 * amount. Validated exactly as the global pipe does — unknown fields refused.
 */

const PIPE = { whitelist: true, forbidNonWhitelisted: true } as const;

async function problems(dto: object): Promise<string[]> {
  const errors = await validate(dto, PIPE);
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('the global pipe refuses what no DTO names', () => {
  it('is configured so, in main.ts', () => {
    expect(readFileSync('src/main.ts', 'utf8')).toMatch(/whitelist: true,\s*forbidNonWhitelisted: true/);
  });
});

describe('asking for another activity', () => {
  const BRANCH = '018f0000-0000-7000-8000-00000000b001';

  it('takes a branch and one of the three activities', async () => {
    for (const activity of ['electronics', 'money_agent', 'both']) {
      expect(await problems(plainToInstance(ActivityRequestDto, { branchId: BRANCH, activity }))).toEqual([]);
    }
  });

  it('refuses any other word, a missing branch, and anything that is not a UUID', async () => {
    expect(await problems(plainToInstance(ActivityRequestDto, { branchId: BRANCH, activity: 'agent' }))).not.toEqual([]);
    expect(await problems(plainToInstance(ActivityRequestDto, { branchId: BRANCH }))).not.toEqual([]);
    expect(await problems(plainToInstance(ActivityRequestDto, { branchId: 'main', activity: 'both' }))).not.toEqual([]);
  });

  it('carries no price: an amount, a status or an effective date sent by the client is refused outright', async () => {
    for (const extra of [{ monthlyAmount: 1 }, { status: 'paid' }, { activityEffective: 'now' }, { activityFrom: 'both' }]) {
      const found = await problems(plainToInstance(ActivityRequestDto, { branchId: BRANCH, activity: 'both', ...extra }));
      expect(found.join(' ')).toMatch(/should not exist/);
    }
  });
});

describe('asking for a store', () => {
  it('names the store, and may say what it does', async () => {
    expect(await problems(plainToInstance(StoreRequestDto, { name: 'Counter' }))).toEqual([]);
    expect(await problems(plainToInstance(StoreRequestDto, { name: 'Counter', activity: 'money_agent' }))).toEqual([]);
    expect(await problems(plainToInstance(StoreRequestDto, { name: 'Counter', activity: 'bank' }))).not.toEqual([]);
  });
});

describe('the public estimate', () => {
  it('takes one activity per store, or none', async () => {
    expect(await problems(plainToInstance(QuoteDto, { stores: [0, 2] }))).toEqual([]);
    expect(await problems(plainToInstance(QuoteDto, { stores: [0, 2], activities: ['money_agent', 'both'] }))).toEqual([]);
    expect(await problems(plainToInstance(QuoteDto, { stores: [0], activities: ['shop'] }))).not.toEqual([]);
    expect(await problems(plainToInstance(QuoteDto, { stores: [0], activities: 'both' }))).not.toEqual([]);
  });
});

describe('registering, by the shop or by the platform', () => {
  const registration = {
    idempotencyKey: 'k-1',
    ownerName: 'Aicha',
    businessName: 'Boutique Aicha',
    branchName: 'Main',
    email: 'aicha@example.test',
    password: 'password-1',
    language: 'en',
  };

  it('may say what the first branch does; electronics is what silence means', async () => {
    expect(await problems(plainToInstance(RegisterDto, registration))).toEqual([]);
    expect(await problems(plainToInstance(RegisterDto, { ...registration, activity: 'both' }))).toEqual([]);
    expect(await problems(plainToInstance(RegisterDto, { ...registration, activity: 'warehouse' }))).not.toEqual([]);

    const admin = { idempotencyKey: 'k-2', ownerName: 'Aicha', businessName: 'Boutique', language: 'fr', reason: 'Signed up by phone' };
    expect(await problems(plainToInstance(CreateBusinessDto, admin))).toEqual([]);
    expect(await problems(plainToInstance(CreateBusinessDto, { ...admin, activity: 'money_agent' }))).toEqual([]);
    expect(await problems(plainToInstance(CreateBusinessDto, { ...admin, activity: 'agent' }))).not.toEqual([]);
  });
});

describe('scheduling a plan version', () => {
  const version = {
    branchMonthly: 500,
    agentMonthly: 300,
    bothMonthly: 700,
    includedStaffPerBranch: 1,
    extraStaffMonthly: 100,
    effectiveFrom: '2027-01-01T00:00:00.000Z',
    reason: 'The approved prices',
  };

  it('prices every activity: the agent and both prices are required whole numbers of MRU', async () => {
    expect(await problems(plainToInstance(PlanVersionDto, version))).toEqual([]);
    const { agentMonthly, ...noAgent } = version;
    void agentMonthly;
    expect(await problems(plainToInstance(PlanVersionDto, noAgent))).not.toEqual([]);
    const { bothMonthly, ...noBoth } = version;
    void bothMonthly;
    expect(await problems(plainToInstance(PlanVersionDto, noBoth))).not.toEqual([]);
    expect(await problems(plainToInstance(PlanVersionDto, { ...version, bothMonthly: -1 }))).not.toEqual([]);
    expect(await problems(plainToInstance(PlanVersionDto, { ...version, agentMonthly: 299.5 }))).not.toEqual([]);
  });
});
