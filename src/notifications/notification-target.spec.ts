import { links, REQUIRES, targetOf, type TargetKind } from './notification-target';
import { NotificationTargetService } from './notification-target.service';

const ID = '0192f0c4-7b1a-7c3e-9a55-1f2e3d4c5b6a';
const UNIT = '0192f0c4-7b1a-7c3e-9a55-aaaaaaaaaaaa';

describe('targetOf — only typed destinations lead anywhere (D225)', () => {
  it.each<[string, TargetKind, string | null, string | null]>([
    [links.sale(ID), 'sale', ID, null],
    [links.return(ID), 'return', ID, null],
    [links.approval(ID), 'approval', ID, null],
    [links.transfer(ID), 'transfer', ID, null],
    [links.loan(ID), 'loan', ID, null],
    [links.consignment(ID), 'consignment', ID, null],
    [links.discrepancy(ID), 'discrepancy', ID, null],
    [links.expense(ID), 'expense', ID, null],
    [links.closingDay('2026-10-30'), 'closing_day', null, '2026-10-30'],
    ['/closing', 'closing_day', null, null],
    [links.stock(), 'stock', null, null],
    [links.product(ID), 'product', ID, null],
    [links.product(ID, UNIT), 'product', ID, UNIT],
    [links.analytics(), 'analytics', null, null],
    [links.staff(ID), 'staff', ID, null],
    [links.actingOwner(), 'acting_owner', null, null],
  ])('%s → %s', (link, kind, id, detail) => {
    expect(targetOf(link)).toEqual({ kind, id, detail });
  });

  it.each([
    null,
    '',
    'https://example.com/sales/' + ID,
    '//evil/sales/' + ID,
    '/sales/' + ID + '/../../x',
    '/sales/not-a-uuid',
    '/sales/' + ID + '?x=1',
    '/closing?date=tomorrow',
    'javascript:alert(1)',
    '/settings',
  ])('%p leads nowhere', (link) => {
    expect(targetOf(link)).toBeNull();
  });

  it('every kind states what its screen requires', () => {
    const kinds: TargetKind[] = ['sale', 'return', 'approval', 'transfer', 'loan', 'consignment', 'discrepancy', 'expense', 'closing_day', 'stock', 'product', 'analytics', 'staff', 'acting_owner'];
    expect(Object.keys(REQUIRES).sort()).toEqual([...kinds].sort());
  });
});

const B1 = Buffer.alloc(16, 1);
const B2 = Buffer.alloc(16, 2);
const ME = Buffer.alloc(16, 7);
const CO = Buffer.alloc(16, 9);

function harness(opts: { link: string | null; visible?: boolean; record?: object | null; perms?: Record<string, string[]>; assigned?: Buffer[] }) {
  const assigned = opts.assigned ?? [B1];
  const notifications = { visibleOne: jest.fn(async () => (opts.visible === false ? null : { id: Buffer.alloc(16), actionLink: opts.link, branchId: B1, type: 'x' })) };
  const find = jest.fn(async () => (opts.record === undefined ? { branchId: B1 } : opts.record));
  const db = {
    sale: { findFirst: find },
    returnRequest: { findFirst: find },
    discountApproval: { findFirst: find },
    closingDiscrepancy: { findFirst: find },
    expense: { findFirst: find },
    stockTransfer: { findFirst: find },
    product: { findFirst: find },
    user: { findFirst: find },
    userBranch: {
      findMany: jest.fn(async () => assigned.map((branchId) => ({ branchId }))),
      findFirst: jest.fn(async ({ where }: { where: { branchId: { in: Buffer[] } } }) => {
        const b = assigned.find((a) => where.branchId.in.some((x) => x.equals(a)));
        return b ? { branchId: b } : null;
      }),
    },
  };
  const prisma = { loan: { findFirst: find }, consignment: { findFirst: find } };
  const access = {
    getEffectivePermissions: jest.fn(async (_u: Buffer, branchId: Buffer) => {
      if (!assigned.some((a) => a.equals(branchId))) throw new Error('branch_access_denied');
      return new Set(opts.perms?.[branchId.toString('hex')] ?? []);
    }),
  };
  return new NotificationTargetService(db as never, prisma as never, access as never, notifications as never);
}

describe('NotificationTargetService.open — re-authorised when opened (D225)', () => {
  const salePerm = { [B1.toString('hex')]: ['sale.view'] };

  it('opens the sale, in the store it belongs to, for a member who may see sales', async () => {
    const r = await harness({ link: links.sale(ID), perms: salePerm }).open(ME, CO, Buffer.alloc(16));
    expect(r).toEqual({ status: 'ok', target: { kind: 'sale', id: ID, detail: null }, branchId: '01010101-0101-0101-0101-010101010101' });
  });

  it('a notification that is not (or no longer) theirs is unavailable — it says nothing about what it names', async () => {
    expect(await harness({ link: links.sale(ID), visible: false, perms: salePerm }).open(ME, CO, Buffer.alloc(16))).toEqual({ status: 'unavailable' });
  });

  it('a record since removed is unavailable', async () => {
    expect(await harness({ link: links.sale(ID), record: null, perms: salePerm }).open(ME, CO, Buffer.alloc(16))).toEqual({ status: 'unavailable' });
  });

  it('a person demoted since the event is unauthorized, not shown the record', async () => {
    expect(await harness({ link: links.sale(ID), perms: {} }).open(ME, CO, Buffer.alloc(16))).toEqual({ status: 'unauthorized' });
  });

  it('a record of a store the person does not work in is unauthorized', async () => {
    const r = await harness({ link: links.sale(ID), record: { branchId: B2 }, perms: { [B2.toString('hex')]: ['sale.view'] } }).open(ME, CO, Buffer.alloc(16));
    expect(r).toEqual({ status: 'unauthorized' });
  });

  it('a transfer opens for a member of either store', async () => {
    const r = await harness({ link: links.transfer(ID), record: { fromBranchId: B2, toBranchId: B1 }, perms: { [B1.toString('hex')]: ['transfer.view'] } }).open(ME, CO, Buffer.alloc(16));
    expect(r).toMatchObject({ status: 'ok', target: { kind: 'transfer' } });
  });

  it('a link that is not a typed destination opens the centre only', async () => {
    expect(await harness({ link: 'https://example.com' }).open(ME, CO, Buffer.alloc(16))).toEqual({ status: 'no_destination' });
    expect(await harness({ link: null }).open(ME, CO, Buffer.alloc(16))).toEqual({ status: 'no_destination' });
  });

  it('a role change opens for the person it is about, and for nobody else without user.manage', async () => {
    const mine = await harness({ link: links.staff(ID), record: { id: ME } }).open(ME, CO, Buffer.alloc(16));
    expect(mine).toMatchObject({ status: 'ok', target: { kind: 'staff' } });
    const theirs = await harness({ link: links.staff(ID), record: { id: B2 }, perms: {} }).open(ME, CO, Buffer.alloc(16));
    expect(theirs).toEqual({ status: 'unauthorized' });
  });

  it('stock opens for any member of the store', async () => {
    expect(await harness({ link: links.stock(), perms: {} }).open(ME, CO, Buffer.alloc(16))).toMatchObject({ status: 'ok', target: { kind: 'stock' } });
  });

  it('a closed day needs closing or report access', async () => {
    expect(await harness({ link: links.closingDay('2026-10-30'), perms: {} }).open(ME, CO, Buffer.alloc(16))).toEqual({ status: 'unauthorized' });
    expect(await harness({ link: links.closingDay('2026-10-30'), perms: { [B1.toString('hex')]: ['report.view'] } }).open(ME, CO, Buffer.alloc(16))).toMatchObject({ status: 'ok' });
  });
});
