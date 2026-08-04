import { CodeType } from '@prisma/client';
import { RecognitionService } from './recognition.service';
import { DefaultConfidenceScorer } from './confidence/default-confidence.scorer';

// Minimal in-memory stand-in for the Prisma productRecognition delegate,
// including support for Prisma's { increment: n } update operator.
class FakeStore {
  rows: any[] = [];
  private seq = 0;
  findFirst({ where }: any) {
    return Promise.resolve(
      this.rows.find((r) => r.codeType === where.codeType && r.code === where.code) ?? null,
    );
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

describe('RecognitionService (learning statistics)', () => {
  const company = Buffer.alloc(16, 1);
  const productA = Buffer.alloc(16, 0xaa);
  const productB = Buffer.alloc(16, 0xbb);
  const CODE = { codeType: CodeType.barcode, code: '6001234500009' };

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

  it('creates a new mapping with confirmations=1 and source stats', async () => {
    await svc.learn({ ...CODE, productId: productA, source: 'receiving' });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ confirmations: 1, corrections: 0, timesSeen: 1 });
    expect(store.rows[0].sourceStats).toEqual({ receiving: 1 });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ reason: 'learned:receiving' }));
  });

  it('reinforces the same mapping (confirmations & source stats accumulate)', async () => {
    await svc.learn({ ...CODE, productId: productA, source: 'receiving' });
    await svc.learn({ ...CODE, productId: productA, source: 'scan' });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ confirmations: 2, corrections: 0, timesSeen: 2 });
    expect(store.rows[0].sourceStats).toEqual({ receiving: 1, scan: 1 });
  });

  it('a correction re-points the aggregate but never loses the observation', async () => {
    await svc.learn({ ...CODE, productId: productA, source: 'receiving' });
    await svc.learn({ ...CODE, productId: productB, source: 'manual' }); // correction

    // aggregate follows the newest decision …
    expect(store.rows).toHaveLength(1);
    expect(Buffer.compare(store.rows[0].productId, productB)).toBe(0);
    expect(store.rows[0]).toMatchObject({ confirmations: 1, corrections: 1 });
    // … and the prior mapping survives as an append-only event.
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'correction:manual' }),
    );
  });

  it('supports multiple barcode aliases pointing to one product', async () => {
    await svc.learn({ codeType: CodeType.barcode, code: 'AAA', productId: productA, source: 'manual' });
    await svc.learn({ codeType: CodeType.barcode, code: 'BBB', productId: productA, source: 'manual' });
    expect(store.rows).toHaveLength(2);
    expect(store.rows.every((r) => Buffer.compare(r.productId, productA) === 0)).toBe(true);
  });

  it('resolve() returns signals the scorer can consume', async () => {
    await svc.learn({ ...CODE, productId: productA, source: 'receiving' });
    const match = await svc.resolve(CODE.codeType, CODE.code);
    expect(match).not.toBeNull();
    expect(match!.signals).toMatchObject({ confirmations: 1, corrections: 0 });
    expect(svc.confidenceOf(match!.signals)).toBeCloseTo(1 / 3, 5);
  });
});
