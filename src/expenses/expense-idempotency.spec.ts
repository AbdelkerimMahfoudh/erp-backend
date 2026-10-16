import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ExpensesService } from './expenses.service';
import { fingerprintExpense } from './expense-rules';
import { binToUuid } from '../common/utils/uuid.util';

/**
 * One client key, one expense — under a race too.
 *
 * Found over real HTTP (2026-10-16): ten identical reports sent at once with one key recorded one expense, but nine
 * callers were told 409 "A record with these values already exists". Each passed the replay check before any had
 * written, and the unique key on (company, client_uuid) refused the losers. A phone retrying on a bad connection
 * is told its report failed when it is in the books. The loser now answers with its twin's expense, exactly as a
 * replay does; a different payload under the key is still refused.
 */

const COMPANY = Buffer.alloc(16, 1);
const BRANCH = Buffer.alloc(16, 2);
const USER = Buffer.alloc(16, 3);
const TWIN = Buffer.alloc(16, 4);
const KEY = '11111111-2222-4333-8444-555555555555';
const dto = { category: 'transport', amount: 75, expenseClass: 'variable' as const, note: 'race', clientUuid: KEY };
const fingerprint = fingerprintExpense({
  category: dto.category,
  amount: dto.amount,
  method: 'cash',
  receivingAccountId: undefined,
  expenseClass: 'variable',
  dueDate: undefined,
  note: dto.note,
});

const raced = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the constraint: `ux_expenses_company_client_uuid`', {
    code: 'P2002',
    clientVersion: 'test',
  });

function harness(twinHash: string) {
  const db: any = {
    expense: {
      // Nothing existed when this request looked; by the time it wrote, its twin had.
      findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: TWIN, clientRequestHash: twinHash }),
      create: jest.fn(async () => {
        throw raced();
      }),
    },
  };
  const tenant: any = { companyId: () => COMPANY, requireBranchId: () => BRANCH, userId: () => USER };
  const audit: any = { record: jest.fn() };
  const businessDay: any = { today: async () => '2026-10-16' };
  const service = new ExpensesService(db, tenant, audit, { get: () => new Set() } as never, {} as never, {} as never, businessDay, {} as never);
  const detail = jest.spyOn(service, 'detail').mockImplementation(async (id: string) => ({ id }) as never);
  return { service, db, audit, detail };
}

describe('two identical expense reports racing', () => {
  it('the loser answers with the expense its twin recorded, and writes no audit row of its own', async () => {
    const { service, audit, detail } = harness(fingerprint);

    const r = (await service.create(dto as never)) as { id: string };

    expect(r.id).toBe(binToUuid(TWIN));
    expect(detail).toHaveBeenCalledWith(binToUuid(TWIN));
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('a twin under the same key that recorded something else is still refused', async () => {
    const { service } = harness('another-payload');

    const caught = await service.create(dto as never).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(ConflictException);
    expect((caught as ConflictException).getResponse()).toMatchObject({ code: 'idempotency_conflict' });
  });

  it('a unique violation with no key to replay is not swallowed', async () => {
    const { service, db } = harness(fingerprint);
    db.expense.findFirst = jest.fn(async () => null);

    await expect(service.create({ ...dto, clientUuid: undefined } as never)).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });
});
