import { referencedIds, shapeUnitTimeline, type RawUnitAuditEvent, type TimelineLookups } from './unit-timeline';

/**
 * A phone's history as language-free facts. Every assertion is about a way the
 * screen could mislead: a raw action as a label, a transition invented from a
 * neighbour, an English system sentence shown as if it were a reason, or
 * repeated entries silently collapsed.
 */

const b = (n: number) => Buffer.from(n.toString(16).padStart(32, '0'), 'hex');
const uuid = (buf: Buffer) => {
  const h = buf.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

const MAIN = b(1);
const WAREHOUSE = b(2);
const OWNER = b(10);
const CLERK = b(11);

const lookups: TimelineLookups = {
  users: new Map([
    [OWNER.toString('hex'), { name: 'Demo Owner', roles: new Map([[MAIN.toString('hex'), 'owner']]) }],
    [
      CLERK.toString('hex'),
      { name: 'Sara', roles: new Map([[WAREHOUSE.toString('hex'), 'store_employee'], [MAIN.toString('hex'), 'store_manager']]) },
    ],
  ]),
  branches: new Map([
    [MAIN.toString('hex'), 'Main Store'],
    [WAREHOUSE.toString('hex'), 'Warehouse'],
  ]),
};

let seq = 0n;
const ev = (over: Partial<RawUnitAuditEvent>): RawUnitAuditEvent => ({
  id: ++seq,
  at: new Date(Date.UTC(2026, 7, 1, 10, Number(seq))),
  entityType: 'Unit',
  action: 'status_change',
  before: null,
  after: null,
  reason: null,
  userId: OWNER,
  branchId: MAIN,
  ...over,
});

describe('unit timeline facts', () => {
  it('is newest first', () => {
    const rows = shapeUnitTimeline([ev({ action: 'create' }), ev({ before: { status: 'in_stock' }, after: { status: 'sold' } })], lookups);
    expect(rows.map((r) => r.action)).toEqual(['status_change', 'create']);
  });

  it('carries the transition the entry recorded, and never invents one', () => {
    const [sale] = shapeUnitTimeline([ev({ before: { status: 'in_stock' }, after: { status: 'sold' } })], lookups);
    expect([sale.fromStatus, sale.toStatus]).toEqual(['in_stock', 'sold']);

    const [legacy] = shapeUnitTimeline([ev({ before: null, after: { identifier: '358888000000014' } })], lookups);
    expect([legacy.fromStatus, legacy.toStatus]).toEqual([null, null]);
  });

  it('turns known system reasons into stable codes, from the column or from `after`', () => {
    const rows = shapeUnitTimeline(
      [
        ev({ before: { status: 'sold' }, after: { status: 'returned', reason: 'return custody intake' } }),
        ev({ before: { status: 'reserved' }, after: { status: 'in_stock' }, reason: 'transfer cancelled' }),
        ev({ before: { status: 'returned' }, after: { status: 'faulty', reason: 'return approved — held, not sellable' } }),
      ],
      lookups,
    );
    expect(rows.map((r) => r.context)).toEqual(['return_approved', 'transfer_cancelled', 'return_intake']);
  });

  it('does not promote an unknown reason to a code, but keeps it for technical detail', () => {
    const [row] = shapeUnitTimeline([ev({ reason: 'something typed by hand' })], lookups);
    expect(row.context).toBeNull();
    expect(row.reason).toBe('something typed by hand');
  });

  it('names the actor with their role at the branch where it happened', () => {
    const [atWarehouse] = shapeUnitTimeline([ev({ userId: CLERK, branchId: WAREHOUSE })], lookups);
    expect(atWarehouse.actor).toEqual({ name: 'Sara', role: 'store_employee' });
    const [system] = shapeUnitTimeline([ev({ userId: null })], lookups);
    expect(system.actor).toBeNull();
  });

  it('names the destination and origin of a transfer', () => {
    const [sent] = shapeUnitTimeline(
      [ev({ before: { status: 'reserved' }, after: { status: 'in_transit', toBranch: uuid(WAREHOUSE), transferId: 'T-1' } })],
      lookups,
    );
    expect(sent.toBranch).toEqual({ name: 'Warehouse' });
    expect(sent.transferId).toBe('T-1');

    const [arrived] = shapeUnitTimeline(
      [ev({ branchId: WAREHOUSE, before: { status: 'in_transit' }, after: { status: 'in_stock', branch: uuid(WAREHOUSE), fromBranch: uuid(MAIN) } })],
      lookups,
    );
    expect(arrived.toBranch).toEqual({ name: 'Warehouse' });
    expect(arrived.fromBranch).toEqual({ name: 'Main Store' });
    expect(arrived.branch).toEqual({ name: 'Warehouse' });
  });

  it('keeps every repeated entry — nothing is merged or dropped', () => {
    const same = () => ev({ before: { status: 'in_stock' }, after: { status: 'in_transit' } });
    expect(shapeUnitTimeline([same(), same(), same(), same()], lookups)).toHaveLength(4);
  });

  it('keeps the legacy fields an older client reads', () => {
    const [row] = shapeUnitTimeline([ev({ action: 'create', after: { identifier: 'X' } })], lookups);
    expect(row).toMatchObject({ entity: 'Unit', action: 'create', after: { identifier: 'X' }, by: uuid(OWNER) });
  });

  it('collects every user and branch it needs in one pass', () => {
    const ids = referencedIds([
      ev({ userId: CLERK, after: { status: 'in_transit', toBranch: uuid(WAREHOUSE) } }),
      ev({ userId: OWNER }),
    ]);
    expect(ids.userIds).toHaveLength(2);
    expect(ids.branchIds.map((x) => x.toString('hex')).sort()).toEqual([MAIN, WAREHOUSE].map((x) => x.toString('hex')).sort());
  });
});
