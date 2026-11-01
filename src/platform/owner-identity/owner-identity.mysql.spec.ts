import { PrismaClient } from '@prisma/client';
import { newUuidV7Bin } from '../../common/utils/uuid.util';
import { claimedBy, claimOwnerContactsTx, OwnerIdentityTakenError } from './owner-identity';

/**
 * Owner identity on REAL MySQL (D227, 0116): the unique index is what decides a race, so only a real server shows it.
 * Env-gated: OWNER_IDENTITY_URL names a DISPOSABLE database with 0116 applied.
 */
const URL = process.env.OWNER_IDENTITY_URL ?? '';
const run = URL !== '' ? describe : describe.skip;

jest.setTimeout(60_000);

run('owner identities', () => {
  let db: PrismaClient;
  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: URL } } });
  });
  afterAll(() => db.$disconnect());

  async function owner() {
    const companyId = newUuidV7Bin();
    const userId = newUuidV7Bin();
    const tag = companyId.toString('hex').slice(-10);
    await db.company.create({ data: { id: companyId, name: `C${tag}`, publicStoreId: tag.toUpperCase(), currency: 'MRU', timezone: 'Africa/Nouakchott', settingsJson: {} } });
    await db.user.create({ data: { id: userId, companyId, name: 'O', login: `o-${tag}`, personalId: `U-${tag.slice(0, 8)}`, passwordHash: 'x' } });
    return { companyId, userId };
  }

  it('of two Owners claiming one number at once, exactly one wins', async () => {
    const [a, b] = await Promise.all([owner(), owner()]);
    const phone = `+2224${Date.now().toString().slice(-7)}`;
    const results = await Promise.allSettled(
      [a, b].map((o) => db.$transaction((tx) => claimOwnerContactsTx(tx, o.companyId, o.userId, { phone }))),
    );
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(OwnerIdentityTakenError);
    expect(await db.ownerIdentity.count({ where: { kind: 'phone', value: phone } })).toBe(1);
  });

  it('compares emails without regard to case', async () => {
    const [a, b] = await Promise.all([owner(), owner()]);
    const email = `Owner.${Date.now()}@Example.test`;
    await db.$transaction((tx) => claimOwnerContactsTx(tx, a.companyId, a.userId, { email }));
    await expect(db.$transaction((tx) => claimOwnerContactsTx(tx, b.companyId, b.userId, { email: email.toUpperCase() }))).rejects.toBeInstanceOf(OwnerIdentityTakenError);
    expect((await claimedBy(db, 'email', email.toLowerCase()))?.userId.equals(a.userId)).toBe(true);
  });
});
