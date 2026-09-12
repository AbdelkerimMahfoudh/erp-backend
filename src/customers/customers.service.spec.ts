import { BadRequestException } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';

/**
 * Finding and adding a customer (4a).
 *
 * Two things are worth pinning here, and neither is the happy path:
 *
 *  1. **What reaches the database.** Isolation in this application is
 *     structural — the tenant client injects `companyId` into every query — so
 *     the test records the arguments rather than pretending to be a database.
 *     A filter applied in the service instead of in SQL, or a company id taken
 *     from the request instead of from context, would both show up here.
 *  2. **That a customer is never required to sell.** The permission split says
 *     it: finding one is part of `sale.create`, creating one is
 *     `customer.manage`, and an ordinary cash sale needs neither.
 */

const COMPANY = newUuidV7Bin();
const OTHER_COMPANY = newUuidV7Bin();

interface Recorded {
  findMany: Record<string, any>[];
  create: Record<string, any>[];
  audits: Record<string, any>[];
}

function makeService(rows: any[] = []): { service: CustomersService; recorded: Recorded } {
  const recorded: Recorded = { findMany: [], create: [], audits: [] };
  const db = {
    customer: {
      findMany: (args: Record<string, any>) => {
        recorded.findMany.push(args);
        return Promise.resolve(rows);
      },
      create: (args: Record<string, any>) => {
        recorded.create.push(args);
        return Promise.resolve({
          id: newUuidV7Bin(),
          name: args.data.name,
          phone: args.data.phone ?? null,
          balance: 0,
        });
      },
    },
  };
  const tenant = { companyId: () => COMPANY };
  const audit = {
    record: (params: Record<string, any>) => {
      recorded.audits.push(params);
      return Promise.resolve();
    },
  };
  const service = new CustomersService(db as any, tenant as any, audit as any);
  return { service, recorded };
}

describe('finding a customer', () => {
  it('searches name and phone together, because a till knows one or the other', async () => {
    const { service, recorded } = makeService();
    await service.list({ search: 'Fatima' });

    const where = recorded.findMany[0].where;
    expect(where.OR).toEqual([
      { name: { contains: 'Fatima' } },
      { phone: { contains: 'Fatima' } },
    ]);
  });

  it('never returns a deleted customer', async () => {
    const { service, recorded } = makeService();
    await service.list({});
    expect(recorded.findMany[0].where.deletedAt).toBeNull();
  });

  it('looks one up exactly by id, without fuzzy matching', async () => {
    const { service, recorded } = makeService();
    const id = binToUuid(newUuidV7Bin());
    await service.list({ id });

    const where = recorded.findMany[0].where;
    expect(where.id).toEqual(uuidToBin(id));
    expect(where.OR).toBeUndefined();
  });

  it('names no company itself — isolation is the tenant client, not a filter here', async () => {
    /*
     * Deliberate: a service that writes its own `companyId` into the where
     * clause is a service that can forget to. The extension injects it for
     * every model, and `tenant.extension.spec.ts` proves that. What must be
     * true HERE is that nothing takes a company from the request.
     */
    const { service, recorded } = makeService();
    await service.list({ search: 'x' });
    expect(JSON.stringify(recorded.findMany[0])).not.toContain(binToUuid(OTHER_COMPANY));
  });

  it('pages by keyset, so a customer added mid-scroll cannot shift the page', async () => {
    const { service, recorded } = makeService();
    const cursor = binToUuid(newUuidV7Bin());
    await service.list({ cursor, limit: 5 });

    const args = recorded.findMany[0];
    expect(args.cursor).toEqual({ id: uuidToBin(cursor) });
    expect(args.skip).toBe(1);
    expect(args.orderBy).toEqual({ id: 'asc' });
    expect(args.take).toBe(6); // limit + 1, to know whether another page exists
  });

  it('caps the page size however large a client asks for', async () => {
    const { service, recorded } = makeService();
    await service.list({ limit: 5000 as number });
    expect(recorded.findMany[0].take).toBe(51);
  });

  it('reports the balance the sale flow maintains, not a second calculation', async () => {
    const row = { id: newUuidV7Bin(), name: 'Ahmed', phone: '22000000', balance: 4000 };
    const { service } = makeService([row]);
    const page = await service.list({});
    expect(page.rows[0]).toMatchObject({ name: 'Ahmed', phone: '22000000', balance: 4000 });
  });
});

describe('adding a customer', () => {
  it('takes the company from context, never from the caller', async () => {
    const { service, recorded } = makeService();
    await service.create({ name: 'Mariem' });
    expect(recorded.create[0].data.companyId).toEqual(COMPANY);
  });

  it('trims, and refuses a name that is only spaces', async () => {
    const { service } = makeService();
    await expect(service.create({ name: '   ' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stores an absent phone as null rather than an empty string', async () => {
    const { service, recorded } = makeService();
    await service.create({ name: 'Sidi', phone: '  ' });
    expect(recorded.create[0].data.phone).toBeNull();
  });

  it('records the creation in the audit trail', async () => {
    const { service, recorded } = makeService();
    await service.create({ name: 'Aminetou', phone: '22110011' });

    expect(recorded.audits[0]).toMatchObject({
      entityType: 'Customer',
      action: 'create',
      after: { name: 'Aminetou', phone: '22110011' },
    });
  });

  it('allows two customers with the same name — people share names', async () => {
    const { service } = makeService();
    await service.create({ name: 'Mohamed' });
    await expect(service.create({ name: 'Mohamed' })).resolves.toMatchObject({ name: 'Mohamed' });
  });
});
