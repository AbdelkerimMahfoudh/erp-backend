import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { binToUuid, isUuid, uuidToBin } from '../common/utils/uuid.util';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformAuditService } from './platform-audit.service';
import type { PlatformAdminIdentity } from './platform-admin.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';

export const MAX_PROOF_BYTES = 5 * 1024 * 1024;
/** How long a decided proof's file is kept. The decision and its figures stay; the image of somebody's receipt does not. */
export const PROOF_RETENTION_DAYS = 365;

/** By its bytes, never its name or the type it claims. Only these three, none of which runs in a browser here. */
export function sniffProof(buffer: Buffer): 'application/pdf' | 'image/png' | 'image/jpeg' | null {
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  return null;
}

const VIEW = {
  id: true,
  companyId: true,
  status: true,
  amount: true,
  paidAt: true,
  reference: true,
  note: true,
  contentType: true,
  byteSize: true,
  refusalReason: true,
  months: true,
  submittedAt: true,
  decidedAt: true,
  purgedAt: true,
} as const;

type Row = Prisma.PaymentProofGetPayload<{ select: typeof VIEW }>;

function view(r: Row) {
  return {
    id: binToUuid(r.id),
    companyId: binToUuid(r.companyId),
    status: r.status,
    amount: r.amount.toString(),
    paidAt: r.paidAt.toISOString(),
    reference: r.reference,
    note: r.note,
    contentType: r.contentType,
    byteSize: r.byteSize,
    refusalReason: r.refusalReason,
    months: r.months,
    submittedAt: r.submittedAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    fileAvailable: r.purgedAt === null,
  };
}

interface Actor {
  admin: PlatformAdminIdentity;
  ip?: string | null;
}

/**
 * A payment proof from the Owner's web portal (D227). Asking changes nothing about access: only an administrator's approval
 * records a payment, with the amount, method and period they verified. Every read and write names its company, so one
 * business can never reach another's. Never reachable from the iOS app (Apple 3.1.1; docs/113).
 */
@Injectable()
export class PaymentProofsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: SubscriptionLifecycleService,
    private readonly audit: PlatformAuditService,
  ) {}

  async submit(
    companyId: Buffer,
    file: { buffer: Buffer } | undefined,
    input: { idempotencyKey: string; amount: string; paidAt: string; reference?: string; note?: string; userId: Buffer },
  ) {
    const key = input.idempotencyKey?.trim();
    if (!key || key.length > 80) throw new BadRequestException({ code: 'proof_key_missing', message: 'Missing request key.' });
    const replay = await this.prisma.paymentProof.findFirst({ where: { companyId, idempotencyKey: key }, select: VIEW });
    if (replay) return view(replay);

    if (!file?.buffer?.length) throw new BadRequestException({ code: 'proof_file_missing', message: 'Choose a file.' });
    if (file.buffer.length > MAX_PROOF_BYTES) throw new BadRequestException({ code: 'proof_too_large', message: 'The file is too large.' });
    const contentType = sniffProof(file.buffer);
    if (!contentType) throw new BadRequestException({ code: 'proof_type', message: 'Send a PDF, PNG or JPEG file.' });
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) throw new BadRequestException({ code: 'amount_invalid', message: 'Enter the amount paid.' });
    const paidAt = new Date(input.paidAt);
    if (Number.isNaN(paidAt.getTime()) || paidAt.getTime() > Date.now() + 5 * 60_000) {
      throw new BadRequestException({ code: 'paid_at_invalid', message: 'The payment date cannot be in the future.' });
    }
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');

    return this.prisma.$transaction(async (tx) => {
      // The company row serialises two submissions: one open proof at a time.
      await tx.$queryRaw(Prisma.sql`SELECT id FROM companies WHERE id = ${companyId} FOR UPDATE`);
      const open = await tx.paymentProof.findFirst({ where: { companyId, status: { in: ['submitted', 'under_review'] } }, select: { id: true } });
      if (open) throw new ConflictException({ code: 'proof_open', message: 'A proof is already waiting for review.' });
      // A refused file may come back corrected; one already approved has been counted.
      const counted = await tx.paymentProof.findFirst({ where: { companyId, sha256, status: 'approved' }, select: { id: true } });
      if (counted) throw new ConflictException({ code: 'proof_duplicate', message: 'This file has already been approved.' });
      const row = await tx.paymentProof.create({
        data: {
          id: newUuidV7Bin(),
          companyId,
          idempotencyKey: key,
          status: 'submitted',
          amount: new Prisma.Decimal(input.amount),
          paidAt,
          reference: input.reference?.trim().slice(0, 120) || null,
          note: input.note?.trim().slice(0, 500) || null,
          contentType,
          byteSize: file.buffer.length,
          sha256,
          file: file.buffer,
          submittedBy: input.userId,
        },
        select: VIEW,
      });
      return view(row);
    });
  }

  async listForCompany(companyId: Buffer) {
    const rows = await this.prisma.paymentProof.findMany({ where: { companyId }, orderBy: { submittedAt: 'desc' }, take: 50, select: VIEW });
    return rows.map(view);
  }

  async listForAdmin(status?: string) {
    await this.purgeExpired();
    const rows = await this.prisma.paymentProof.findMany({
      where: status ? { status: status as never } : { status: { in: ['submitted', 'under_review'] } },
      orderBy: { submittedAt: 'asc' },
      take: 100,
      select: VIEW,
    });
    return rows.map(view);
  }

  /** On the administrator's own read: no job to fail silently, and at most a list's delay late. */
  async purgeExpired(now = new Date()) {
    const before = new Date(now.getTime() - PROOF_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.paymentProof.updateMany({
      where: { decidedAt: { lt: before }, purgedAt: null },
      data: { file: null, purgedAt: now },
    });
    return count;
  }

  async file(id: string, ctx: Actor) {
    if (!isUuid(id)) throw new NotFoundException('Unknown proof');
    const row = await this.prisma.paymentProof.findUnique({ where: { id: uuidToBin(id) }, select: { id: true, companyId: true, file: true, contentType: true } });
    if (!row) throw new NotFoundException('Unknown proof');
    if (!row.file) throw new ConflictException({ code: 'proof_purged', message: 'This file is no longer kept.' });
    await this.record('payment_proof.view', row.companyId, id, null, {}, ctx);
    return { file: Buffer.from(row.file), contentType: row.contentType };
  }

  async review(id: string, ctx: Actor) {
    const row = await this.rowOf(id);
    const moved = await this.prisma.paymentProof.updateMany({ where: { id: row.id, status: 'submitted' }, data: { status: 'under_review' } });
    if (moved.count) await this.record('payment_proof.review', row.companyId, id, null, {}, ctx);
    return view(await this.rowOf(id));
  }

  async refuse(id: string, reason: string, ctx: Actor) {
    const why = reason?.trim();
    if (!why) throw new BadRequestException({ code: 'reason_required', message: 'Say why: the Owner reads this.' });
    const row = await this.rowOf(id);
    const moved = await this.prisma.paymentProof.updateMany({
      where: { id: row.id, status: { in: ['submitted', 'under_review'] }, appliedAt: null },
      data: { status: 'refused', refusalReason: why.slice(0, 500), decidedAt: new Date() },
    });
    if (!moved.count) throw new ConflictException({ code: 'proof_decided', message: 'This proof has already been decided.' });
    await this.record('payment_proof.refuse', row.companyId, id, why, {}, ctx);
    return view(await this.rowOf(id));
  }

  /**
   * The verified amount, method and period become a real payment. The period is claimed before it is applied, because
   * extending twice cannot be recognised afterwards: a failure releases the claim, while a crash between the two leaves
   * `proof_applying` for a person to check, which can never double a period.
   */
  async approve(
    id: string,
    input: { amount: string; paidAt: string; channel?: 'manual' | 'bank_transfer' | 'mobile_money'; months: number; reason: string },
    ctx: Actor,
  ) {
    const row = await this.rowOf(id);
    if (row.status === 'approved') return view(row);
    if (row.status !== 'submitted' && row.status !== 'under_review') throw new ConflictException({ code: 'proof_decided', message: 'This proof has already been decided.' });
    if (!Number.isInteger(input.months) || input.months < 1 || input.months > 60) throw new BadRequestException({ code: 'months_invalid', message: 'Choose the period paid for.' });
    const paidAt = new Date(input.paidAt);
    if (Number.isNaN(paidAt.getTime())) throw new BadRequestException({ code: 'paid_at_invalid', message: 'Enter the payment date.' });
    if (!input.reason?.trim()) throw new BadRequestException({ code: 'reason_required', message: 'Say why.' });

    const claimed = await this.prisma.paymentProof.updateMany({ where: { id: row.id, appliedAt: null, status: { in: ['submitted', 'under_review'] } }, data: { appliedAt: new Date() } });
    if (!claimed.count) throw new ConflictException({ code: 'proof_applying', message: 'This proof is being applied, or stopped part-way. Check the business before trying again.' });

    const company = binToUuid(row.companyId);
    try {
      await this.lifecycle.recordPayment(
        company,
        { amount: input.amount, paidAt, channel: input.channel, reference: `proof:${id}`, note: input.reason, confirm: true },
        { admin: ctx.admin, ip: ctx.ip ?? undefined } as never,
      );
      const sub = await this.prisma.subscription.findFirst({ where: { companyId: row.companyId }, select: { status: true } });
      if (sub?.status === 'pending_activation' || sub?.status === 'rejected') {
        await this.lifecycle.approve(company, { months: input.months, reason: input.reason }, { admin: ctx.admin, ip: ctx.ip ?? undefined } as never);
      } else {
        await this.lifecycle.extend(company, { months: input.months, reason: input.reason }, { admin: ctx.admin, ip: ctx.ip ?? undefined } as never);
      }
    } catch (e) {
      await this.prisma.paymentProof.updateMany({ where: { id: row.id, status: { not: 'approved' } }, data: { appliedAt: null } });
      throw e;
    }
    await this.prisma.paymentProof.update({
      where: { id: row.id },
      data: { status: 'approved', months: input.months, decidedAt: new Date(), refusalReason: null },
    });
    await this.record('payment_proof.approve', row.companyId, id, input.reason, { amount: input.amount, months: input.months }, ctx);
    return view(await this.rowOf(id));
  }

  private async rowOf(id: string): Promise<Row> {
    if (!isUuid(id)) throw new NotFoundException('Unknown proof');
    const row = await this.prisma.paymentProof.findUnique({ where: { id: uuidToBin(id) }, select: VIEW });
    if (!row) throw new NotFoundException('Unknown proof');
    return row;
  }

  private record(action: string, companyId: Buffer, proof: string, reason: string | null, after: Record<string, unknown>, ctx: Actor) {
    return this.audit.record({
      admin: ctx.admin,
      action,
      targetType: 'Company',
      targetId: companyId,
      targetLabel: null,
      reason,
      after: { proof, ...after, outcome: 'applied' },
      ip: ctx.ip ?? null,
    });
  }
}
