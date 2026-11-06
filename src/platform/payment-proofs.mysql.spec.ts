import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { MAX_PROOF_BYTES, PaymentProofsService, sniffProof } from './payment-proofs.service';

/**
 * Payment proofs on real MySQL (D227): one business cannot see another's, one open at a time, a retry is the same proof, and
 * only an approval records a payment, once. The lifecycle is a stand-in so a failure can be injected at each step.
 */
const url = process.env.PROVISIONING_ROOT_URL;
const suite = url ? describe : describe.skip;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(randomUUID())]);
const ctx = { admin: { id: Buffer.alloc(16, 1), email: 'ops@example.test', name: 'Ops' }, ip: '127.0.0.1' } as never;

describe('what a proof may be', () => {
  it('goes by the bytes, not the name or the claimed type', () => {
    expect(sniffProof(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffProof(PNG)).toBe('image/png');
    expect(sniffProof(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffProof(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
    expect(sniffProof(Buffer.from('<html>'))).toBeNull();
    expect(MAX_PROOF_BYTES).toBe(5 * 1024 * 1024);
  });
});

suite('payment proofs', () => {
  const root = url ? new PrismaClient({ datasources: { db: { url } } }) : (null as unknown as PrismaClient);
  const lifecycle = { recordPayment: jest.fn(), approve: jest.fn(), extend: jest.fn() };
  const audit = { record: jest.fn() };
  const service = new PaymentProofsService(root as never, lifecycle as never, audit as never, { forCompany: async () => ({ seatsByStore: [] }) } as never, { proofSubmitted: async () => ({ sent: 0 }) } as never, { applyPaidTx: jest.fn(), listForCompany: async () => [] } as never);
  const user = Buffer.alloc(16, 7);
  afterAll(() => root?.$disconnect());
  beforeEach(() => {
    for (const f of [lifecycle.recordPayment, lifecycle.approve, lifecycle.extend, audit.record]) f.mockReset();
  });

  async function company() {
    const id = Buffer.from(randomUUID().replace(/-/g, ''), 'hex');
    await root.company.create({ data: { id, publicStoreId: randomUUID().slice(0, 12), currency: 'MRU', timezone: 'Africa/Nouakchott', settingsJson: {} } });
    return id;
  }
  const send = (c: Buffer, key = randomUUID(), file = Buffer.concat([PNG, Buffer.from(randomUUID())])) =>
    service.submit(c, { buffer: file }, { idempotencyKey: key, amount: '300', paidAt: '2026-10-01T00:00:00.000Z', userId: user });
  const decision = { amount: '300', paidAt: '2026-10-01T00:00:00.000Z', months: 1, reason: 'seen in the account' };

  it('a business reads only its own; the answer never carries the file', async () => {
    const [a, b] = [await company(), await company()];
    const mine = await send(a);
    expect((await service.listForCompany(b)).map((p) => p.id)).not.toContain(mine.id);
    const [listed] = await service.listForCompany(a);
    expect(listed).not.toHaveProperty('file');
    expect(listed).not.toHaveProperty('sha256');
  });

  it('a retry is the same proof; a second open one is refused, also when two race', async () => {
    const a = await company();
    const key = randomUUID();
    const first = await send(a, key);
    expect((await send(a, key)).id).toBe(first.id);
    await expect(send(a)).rejects.toMatchObject({ response: { code: 'proof_open' } });
    const b = await company();
    const raced = await Promise.allSettled([send(b), send(b)]);
    expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('refused with its reason, then a corrected proof is accepted; an approved file cannot be counted twice', async () => {
    const a = await company();
    const file = Buffer.concat([PNG, Buffer.from(randomUUID())]);
    const first = await send(a, randomUUID(), file);
    await expect(service.refuse(first.id, ' ', ctx)).rejects.toMatchObject({ response: { code: 'reason_required' } });
    expect(await service.refuse(first.id, 'Amount unreadable', ctx)).toMatchObject({ status: 'refused', refusalReason: 'Amount unreadable' });
    const again = await send(a, randomUUID(), file);
    await service.approve(again.id, decision, ctx);
    await expect(send(a, randomUUID(), file)).rejects.toMatchObject({ response: { code: 'proof_duplicate' } });
  });

  it('submitting changes nothing; approving records the payment once, and a failure leaves it open to retry', async () => {
    const a = await company();
    const proof = await send(a);
    expect(lifecycle.recordPayment).not.toHaveBeenCalled();
    lifecycle.extend.mockRejectedValueOnce(new Error('down'));
    await expect(service.approve(proof.id, decision, ctx)).rejects.toThrow('down');
    expect((await service.listForCompany(a))[0]).toMatchObject({ status: 'submitted' });
    expect(await service.approve(proof.id, decision, ctx)).toMatchObject({ status: 'approved', months: 1 });
    expect(await service.approve(proof.id, decision, ctx)).toMatchObject({ status: 'approved' });
    expect(lifecycle.extend).toHaveBeenCalledTimes(2);
    // Recognised by its reference: the same payment both times.
    expect(lifecycle.recordPayment.mock.calls[0][1].reference).toBe(`proof:${proof.id}`);
    expect(lifecycle.recordPayment.mock.calls[1][1].reference).toBe(`proof:${proof.id}`);
    await expect(service.refuse(proof.id, 'late', ctx)).rejects.toMatchObject({ response: { code: 'proof_decided' } });
  });

  it('a stopped application cannot be applied again: a period is never doubled', async () => {
    const a = await company();
    const proof = await send(a);
    await root.paymentProof.updateMany({ where: { companyId: a }, data: { appliedAt: new Date() } });
    await expect(service.approve(proof.id, decision, ctx)).rejects.toMatchObject({ response: { code: 'proof_applying' } });
    expect(lifecycle.extend).not.toHaveBeenCalled();
  });

  it('a year after the decision the file goes and the decision stays', async () => {
    const a = await company();
    const proof = await send(a);
    await service.refuse(proof.id, 'no', ctx);
    await root.paymentProof.updateMany({ where: { companyId: a }, data: { decidedAt: new Date(Date.now() - 366 * 24 * 60 * 60 * 1000) } });
    await service.purgeExpired();
    expect((await service.listForCompany(a))[0]).toMatchObject({ status: 'refused', fileAvailable: false, refusalReason: 'no' });
    await expect(service.file(proof.id, ctx)).rejects.toMatchObject({ response: { code: 'proof_purged' } });
  });

  it('every read of a file is audited', async () => {
    const a = await company();
    const proof = await send(a);
    const got = await service.file(proof.id, ctx);
    expect(got.contentType).toBe('image/png');
    expect(audit.record.mock.calls.map((c) => c[0].action)).toContain('payment_proof.view');
  });
});
