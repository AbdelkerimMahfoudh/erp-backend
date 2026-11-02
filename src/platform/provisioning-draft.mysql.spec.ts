import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { finishDraft, type DraftBasis } from './provisioning-draft';

/**
 * The state machine against real MySQL (D227): a failure leaves a marked draft, a resume finishes it, and only one caller
 * ever completes it. The lifecycle is a recording stand-in here, so a failure can be injected at each step;
 * `store-grant-renewal.mysql.spec.ts` and `subscription-lifecycle` hold the real steps' own replay.
 */
const url = process.env.PROVISIONING_ROOT_URL;
const suite = url ? describe : describe.skip;

suite('an administrator’s account as a draft', () => {
  const root = url ? new PrismaClient({ datasources: { db: { url } } }) : (null as unknown as PrismaClient);
  const ctx = { admin: { email: 'ops@example.test' } };
  afterAll(() => root?.$disconnect());

  async function draft(basis: DraftBasis) {
    const id = Buffer.from(randomUUID().replace(/-/g, ''), 'hex');
    await root.company.create({
      data: {
        id,
        publicStoreId: randomUUID().slice(0, 12),
        currency: 'MRU',
        timezone: 'Africa/Nouakchott',
        settingsJson: {},
        provisioningState: 'draft',
        provisioningBasis: basis as never,
      },
    });
    return { id, uuid: randomUUID() };
  }
  const state = async (id: Buffer) => root.company.findUniqueOrThrow({ where: { id }, select: { provisioningState: true, provisioningBasis: true } });
  const PAID: DraftBasis = { kind: 'payment', reason: 'paid', amount: '300', paidAt: '2026-11-01T00:00:00.000Z', reference: 'R-1', months: 1 };

  it('a failed step leaves the draft, marked and whole; a resume finishes it once', async () => {
    const { id, uuid } = await draft(PAID);
    const recordPayment = jest.fn().mockResolvedValue({});
    const approve = jest.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue({});
    const lifecycle = { recordPayment, approve, activateByGrant: jest.fn() };

    const failed = await finishDraft(root, lifecycle, id, uuid, ctx);
    expect(failed).toMatchObject({ complete: false, completedNow: false });
    expect((await state(id)).provisioningState).toBe('draft');
    expect((await state(id)).provisioningBasis).toMatchObject({ reference: 'R-1' });

    const resumed = await finishDraft(root, lifecycle, id, uuid, ctx);
    expect(resumed).toMatchObject({ complete: true, completedNow: true });
    // The same payment each time: its reference is what the lifecycle recognises it by.
    expect(recordPayment.mock.calls[0][1]).toEqual(recordPayment.mock.calls[1][1]);
    expect(await state(id)).toEqual({ provisioningState: null, provisioningBasis: null });

    expect(await finishDraft(root, lifecycle, id, uuid, ctx)).toMatchObject({ complete: true, completedNow: false });
    expect(recordPayment).toHaveBeenCalledTimes(2);
  });

  it('two resumes at once: exactly one completes it, so one invitation', async () => {
    const { id, uuid } = await draft(PAID);
    const lifecycle = { recordPayment: jest.fn().mockResolvedValue({}), approve: jest.fn().mockResolvedValue({}), activateByGrant: jest.fn() };
    const both = await Promise.all([finishDraft(root, lifecycle, id, uuid, ctx), finishDraft(root, lifecycle, id, uuid, ctx)]);
    expect(both.filter((o) => o.completedNow)).toHaveLength(1);
  });

  it('an ordinary account is never touched', async () => {
    const { id, uuid } = await draft(PAID);
    await root.company.update({ where: { id }, data: { provisioningState: null } });
    const lifecycle = { recordPayment: jest.fn(), approve: jest.fn(), activateByGrant: jest.fn() };
    expect(await finishDraft(root, lifecycle, id, uuid, ctx)).toMatchObject({ complete: true, completedNow: false });
    expect(lifecycle.recordPayment).not.toHaveBeenCalled();
  });
});
