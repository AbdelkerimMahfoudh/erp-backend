import { BusinessDayService } from './business-day.service';

/**
 * Where the business date's two facts are read (the 2026-10-03 rehearsal).
 *
 * `assign()` runs inside the sale, the purchase payment and the money anchor
 * transactions. It used to read the company's timezone through the global
 * client — a second pooled connection taken while the transaction held its
 * own — so as many concurrent sales as the pool had connections waited on each
 * other until all of them timed out. Inside a transaction both facts now come
 * through that transaction; outside one, nothing changes.
 */

const COMPANY = Buffer.from('01a0ff05ba59770c9090140103fcb958', 'hex');
const BRANCH = Buffer.alloc(16, 2);
/** 23:30 on 2 Oct in UTC; 08:30 on 3 Oct in Tokyo. */
const INSTANT = new Date('2026-10-02T23:30:00.000Z');

function setup(globalTimezone = 'UTC') {
  const prisma = {
    company: { findUnique: jest.fn().mockResolvedValue({ timezone: globalTimezone }) },
    closingEvent: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const tenant = { companyId: () => COMPANY };
  return { prisma, service: new BusinessDayService(prisma as never, tenant as never) };
}

function transaction(timezone: string | null, startedEarly = false) {
  return {
    $queryRaw: jest.fn().mockResolvedValue(timezone === null ? [] : [{ timezone }]),
    closingEvent: { findFirst: jest.fn().mockResolvedValue(startedEarly ? { id: Buffer.alloc(16, 9) } : null) },
  };
}

describe('BusinessDayService.assign — the timezone and the early start are read where the caller reads', () => {
  it('inside a transaction: both facts through it, and the global pool is never asked for a connection', async () => {
    const { prisma, service } = setup('UTC');
    const tx = transaction('Asia/Tokyo');

    await expect(service.assign(BRANCH, INSTANT, tx as never)).resolves.toBe('2026-10-03');
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.closingEvent.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.company.findUnique).not.toHaveBeenCalled();
    expect(prisma.closingEvent.findFirst).not.toHaveBeenCalled();
  });

  it('the raw read asks for the timezone of this company and nothing else', async () => {
    const { service } = setup();
    const tx = transaction('UTC');
    await service.assign(BRANCH, INSTANT, tx as never);

    const query = tx.$queryRaw.mock.calls[0][0] as { sql: string; values: unknown[] };
    expect(query.sql).toBe('SELECT timezone FROM companies WHERE id = ? LIMIT 1');
    expect(query.values).toEqual([COMPANY]);
  });

  it('an early start read through the transaction still moves the date on', async () => {
    const { service } = setup();
    await expect(service.assign(BRANCH, INSTANT, transaction('Asia/Tokyo', true) as never)).resolves.toBe('2026-10-04');
  });

  it('outside a transaction: the unscoped client, exactly as before', async () => {
    const { prisma, service } = setup('Asia/Tokyo');

    await expect(service.assign(BRANCH, INSTANT)).resolves.toBe('2026-10-03');
    await expect(service.today(BRANCH)).resolves.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(prisma.company.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.closingEvent.findFirst).toHaveBeenCalledTimes(2);
  });

  it('no row, or a zone that is not one, falls back to UTC inside a transaction too', async () => {
    const { service } = setup('Asia/Tokyo');
    await expect(service.assign(BRANCH, INSTANT, transaction(null) as never)).resolves.toBe('2026-10-02');
    await expect(service.assign(BRANCH, INSTANT, transaction('Mars/Olympus_Mons') as never)).resolves.toBe('2026-10-02');
  });
});
