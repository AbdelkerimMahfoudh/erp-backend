import { CodeType } from '@prisma/client';
import { RecognitionService } from './recognition.service';
import { DefaultConfidenceScorer } from './confidence/default-confidence.scorer';

/**
 * Learning is evidence, never authority (Milestone C).
 *
 * What `learn()` may and may not do to a company's mappings is pinned here:
 * it proposes where nothing is held, counts agreement and disagreement where
 * something is, and never confirms a mapping or moves one to another product.
 * The stand-in for the `productRecognition` delegate honours the status filter
 * and Prisma's `{ increment: n }` operator, so a query that ignored status
 * would fail here rather than in a shop.
 */
class FakeStore {
  rows: any[] = [];
  private seq = 0;
  findMany({ where }: any) {
    const wanted: string[] | null = where.status?.in ?? (where.status ? [where.status] : null);
    return Promise.resolve(
      this.rows
        .filter((r) => r.codeType === where.codeType && r.code === where.code && (!wanted || wanted.includes(r.status)))
        .sort((a, b) => b.__k - a.__k),
    );
  }
  findFirst({ where }: any) {
    return this.findMany({ where }).then((rows) => rows[0] ?? null);
  }
  create({ data }: any) {
    this.rows.push({ ...data, __k: this.seq++ });
    return Promise.resolve(data);
  }
  update({ where, data }: any) {
    const row = this.rows.find((r) => Buffer.compare(r.id, where.id) === 0);
    for (const [k, v] of Object.entries<any>(data)) {
      row[k] = v && typeof v === 'object' && 'increment' in v ? (row[k] ?? 0) + v.increment : v;
    }
    return Promise.resolve(row);
  }
}

describe('RecognitionService — learning is evidence, never authority', () => {
  const company = Buffer.alloc(16, 1);
  const productA = Buffer.alloc(16, 0xaa);
  const productB = Buffer.alloc(16, 0xbb);
  const CODE = { codeType: CodeType.tac, code: '35123456' };

  let store: FakeStore;
  let audit: { record: jest.Mock };
  let svc: RecognitionService;

  beforeEach(() => {
    store = new FakeStore();
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    const tenant = { companyId: () => company, branchId: () => undefined, userId: () => undefined };
    svc = new RecognitionService(
      { productRecognition: store } as any,
      tenant as any,
      audit as any,
      new DefaultConfidenceScorer(),
    );
  });

  /** A mapping the ladder confirmed — what only `catalog.manage` can create. */
  const confirmed = (productId: Buffer, over: Record<string, unknown> = {}) => {
    const now = new Date();
    store.rows.push({
      __k: -1,
      id: Buffer.alloc(16, 0xc0),
      companyId: company,
      ...CODE,
      productId,
      status: 'confirmed',
      confirmedAt: now,
      timesSeen: 1,
      confirmations: 1,
      corrections: 0,
      lastSeenAt: now,
      lastConfirmedAt: now,
      sourceStats: { receiving: 1 },
      ...over,
    });
  };

  it('a first sighting proposes a mapping — it never confirms one', async () => {
    await svc.learn({ ...CODE, productId: productA, source: 'receiving' });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ status: 'proposed', evidenceSource: 'receiving', timesSeen: 1, confirmations: 0, corrections: 0 });
    // The database refuses a confirmed row without confirmed_at; a proposal carries neither.
    expect(store.rows[0].confirmedAt).toBeUndefined();
    expect(store.rows[0].confirmedById).toBeUndefined();
    expect(store.rows[0].sourceStats).toEqual({ receiving: 1 });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ reason: 'proposed:receiving', action: 'create' }));
  });

  it('a proposal seen again with the same product gathers sightings, not confirmations', async () => {
    await svc.learn({ ...CODE, productId: productA, source: 'receiving' });
    await svc.learn({ ...CODE, productId: productA, source: 'scan' });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ status: 'proposed', timesSeen: 2, confirmations: 0, corrections: 0 });
    expect(store.rows[0].sourceStats).toEqual({ receiving: 1, scan: 1 });
    expect(audit.record).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'reinforce:scan' }));
  });

  it('a receipt under a confirmed mapping confirms it once more', async () => {
    confirmed(productA);
    await svc.learn({ ...CODE, productId: productA, source: 'receiving' });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ status: 'confirmed', timesSeen: 2, confirmations: 2, corrections: 0 });
    expect(store.rows[0].sourceStats).toEqual({ receiving: 2 });
  });

  it('a confirmed mapping seen with another product keeps its product and counts the disagreement', async () => {
    confirmed(productA);
    await svc.learn({ ...CODE, productId: productB, source: 'receiving' });

    expect(store.rows).toHaveLength(1);
    expect(Buffer.compare(store.rows[0].productId, productA)).toBe(0);
    expect(store.rows[0]).toMatchObject({ status: 'confirmed', timesSeen: 2, confirmations: 1, corrections: 1 });
    expect(store.rows[0].lastCorrectedAt).toBeInstanceOf(Date);
    // The observation is kept, naming what was seen, so a reviewer can act on it.
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'disagreement:receiving',
        action: 'update',
        after: expect.objectContaining({ observedProductId: expect.stringMatching(/^bbbbbbbb-/) }),
      }),
    );
  });

  it('a proposal seen with another product is not re-pointed either', async () => {
    await svc.learn({ ...CODE, productId: productA, source: 'receiving' });
    await svc.learn({ ...CODE, productId: productB, source: 'receiving' });
    expect(store.rows).toHaveLength(1);
    expect(Buffer.compare(store.rows[0].productId, productA)).toBe(0);
    expect(store.rows[0]).toMatchObject({ status: 'proposed', timesSeen: 2, corrections: 1 });
  });

  it('a superseded row is history — a new sighting opens a new proposal', async () => {
    store.rows.push({
      __k: -2,
      id: Buffer.alloc(16, 0x5e),
      companyId: company,
      ...CODE,
      productId: productA,
      status: 'superseded',
      timesSeen: 3,
      confirmations: 3,
      corrections: 0,
    });
    await svc.learn({ ...CODE, productId: productB, source: 'receiving' });
    expect(store.rows).toHaveLength(2);
    expect(store.rows[0]).toMatchObject({ status: 'superseded', timesSeen: 3 });
    expect(store.rows[1]).toMatchObject({ status: 'proposed', timesSeen: 1 });
    expect(Buffer.compare(store.rows[1].productId, productB)).toBe(0);
  });

  it('the confirmed mapping outranks an open proposal for the same code', async () => {
    await svc.learn({ ...CODE, productId: productB, source: 'receiving' }); // somebody's earlier proposal
    confirmed(productA);
    await svc.learn({ ...CODE, productId: productA, source: 'receiving' });
    expect(store.rows.find((r) => r.status === 'confirmed')).toMatchObject({ timesSeen: 2, confirmations: 2 });
    expect(store.rows.find((r) => r.status === 'proposed')).toMatchObject({ timesSeen: 1 });
  });

  it('supports several barcode aliases for one product — each its own proposal', async () => {
    await svc.learn({ codeType: CodeType.barcode, code: 'AAA', productId: productA, source: 'manual' });
    await svc.learn({ codeType: CodeType.barcode, code: 'BBB', productId: productA, source: 'manual' });
    expect(store.rows).toHaveLength(2);
    expect(store.rows.every((r) => r.status === 'proposed' && Buffer.compare(r.productId, productA) === 0)).toBe(true);
  });

  it('resolve() answers only for a confirmed mapping, with the signals the scorer reads', async () => {
    await svc.learn({ ...CODE, productId: productA, source: 'receiving' });
    // A proposal is never authoritative — nothing reading resolve() may auto-select it.
    expect(await svc.resolve(CODE.codeType, CODE.code)).toBeNull();

    store.rows.length = 0;
    confirmed(productA);
    const match = await svc.resolve(CODE.codeType, CODE.code);
    expect(match).not.toBeNull();
    expect(match!.signals).toMatchObject({ confirmations: 1, corrections: 0 });
    expect(svc.confidenceOf(match!.signals)).toBeCloseTo(1 / 3, 5);
  });
});
