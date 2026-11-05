import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { binToUuid, isUuid, uuidToBin } from '../common/utils/uuid.util';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformAuditService } from './platform-audit.service';
import type { PlatformAdminIdentity } from './platform-admin.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { EntitlementService } from '../entitlement/entitlement.service';
import { isOfferMonths, quote, type Quote } from '../billing/period-offers';
import { PaymentAlertService } from './payment-alert.service';

export const MAX_PROOF_BYTES = 5 * 1024 * 1024;
/** How long a decided proof's file is kept. The decision and its figures stay; the image of somebody's receipt does not. */
export const PROOF_RETENTION_DAYS = 365;
/** How long a claim may belong to an approval still running, before anyone may act on it. */
export const RECOVERY_AFTER_MS = 2 * 60 * 1000;

type Channel = 'manual' | 'bank_transfer' | 'mobile_money';
interface ApplyRequest {
  amount: string;
  paidAt: string;
  channel?: Channel;
  months: number;
  reason: string;
}
class PeriodAlreadyApplied extends Error {}
const refused = (state: { stopped: boolean; mayStillBeRunning: boolean }) =>
  new ConflictException(
    state.mayStillBeRunning
      ? { code: 'proof_may_be_running', message: 'This approval may still be running. Look again in a couple of minutes.' }
      : { code: 'proof_recovery_refused', message: state.stopped ? 'That action does not fit what happened to this proof. Read its recovery again.' : 'This proof has nothing to recover.' },
  );

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
    private readonly entitlement: EntitlementService,
    private readonly alerts: PaymentAlertService,
  ) {}

  /**
   * The portal's offers for this business (owner, 2026-11-05): 1, 3 or 12 months, priced per active store and its paid
   * seats (`billing/period-offers.ts`). The same figures the submission records.
   */
  async quoteFor(companyId: Buffer, months: Parameters<typeof quote>[1]): Promise<Quote> {
    const e = await this.entitlement.forCompany(companyId);
    return quote(
      e.seatsByStore.map((b) => ({ branchId: b.branchId, name: b.name, activity: b.activity ?? 'electronics', paidSeats: b.paidSeats })),
      months,
    );
  }

  async submit(
    companyId: Buffer,
    file: { buffer: Buffer } | undefined,
    input: { idempotencyKey: string; amount?: string; paidAt?: string; months?: number; reference?: string; note?: string; userId: Buffer },
  ) {
    const key = input.idempotencyKey?.trim();
    if (!key || key.length > 80) throw new BadRequestException({ code: 'proof_key_missing', message: 'Missing request key.' });
    const replay = await this.prisma.paymentProof.findFirst({ where: { companyId, idempotencyKey: key }, select: VIEW });
    if (replay) return view(replay);

    if (!file?.buffer?.length) throw new BadRequestException({ code: 'proof_file_missing', message: 'Choose a file.' });
    if (file.buffer.length > MAX_PROOF_BYTES) throw new BadRequestException({ code: 'proof_too_large', message: 'The file is too large.' });
    const contentType = sniffProof(file.buffer);
    if (!contentType) throw new BadRequestException({ code: 'proof_type', message: 'Send a PDF, PNG or JPEG file.' });
    // A plan chosen on the portal (owner, 2026-11-05): the amount is the server's quote for it, paid now — never a figure
    // the page sends. Without a plan, the Owner states the amount and the date, as before.
    let chosen: Quote | null = null;
    if (input.months !== undefined) {
      if (!isOfferMonths(input.months)) throw new BadRequestException({ code: 'plan_invalid', message: 'Choose 1, 3 or 12 months.' });
      chosen = await this.quoteFor(companyId, input.months);
      if (chosen.total <= 0) throw new BadRequestException({ code: 'plan_no_store', message: 'There is no active store to pay for.' });
      input = { ...input, amount: String(chosen.total), paidAt: input.paidAt ?? new Date().toISOString() };
    }
    if (!input.amount || !input.paidAt) throw new BadRequestException({ code: 'proof_fields', message: 'Enter the amount and the date paid.' });
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) throw new BadRequestException({ code: 'amount_invalid', message: 'Enter the amount paid.' });
    const paidAt = new Date(input.paidAt!);
    if (Number.isNaN(paidAt.getTime()) || paidAt.getTime() > Date.now() + 5 * 60_000) {
      throw new BadRequestException({ code: 'paid_at_invalid', message: 'The payment date cannot be in the future.' });
    }
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');

    const saved = await this.prisma.$transaction(async (tx) => {
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
          amount: new Prisma.Decimal(input.amount!),
          months: chosen?.months ?? null,
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
    // After the commit, never inside it: the administrators' WhatsApp alert (owner, 2026-11-05). A failure is logged and
    // the proof waits in the console all the same.
    await this.alerts
      .proofSubmitted({ id: saved.id, companyId, submittedBy: input.userId, amount: saved.amount, months: saved.months, stores: chosen?.lines.map((l) => l.name) ?? [] })
      .catch(() => undefined);
    return saved;
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
    // Said only to the administrator: the Owner's list stays Submitted until there is a decision.
    const stopped = await this.prisma.paymentProof.findMany({ where: { id: { in: rows.map((r) => r.id) }, appliedAt: { not: null } }, select: { id: true } });
    const isStopped = new Set(stopped.map((r) => r.id.toString('hex')));
    return rows.map((r) => ({ ...view(r), applying: isStopped.has(r.id.toString('hex')) && !r.decidedAt }));
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
   * The verified amount, method and period become a real payment. What was decided is stored with the claim, and the period
   * marks the proof in its own transaction, so every step can tell whether it already happened. A failure before any money
   * was recorded releases the claim. After that the claim stays, whatever the failure: a second decision could name another
   * amount and so record a second payment. `recovery` reads such a proof; `completeRecovery` and `releaseRecovery` settle it.
   */
  async approve(
    id: string,
    input: { amount: string; paidAt: string; channel?: Channel; months: number; reason: string },
    ctx: Actor,
  ) {
    const row = await this.rowOf(id);
    if (row.status === 'approved') return view(row);
    if (row.status !== 'submitted' && row.status !== 'under_review') throw new ConflictException({ code: 'proof_decided', message: 'This proof has already been decided.' });
    if (!Number.isInteger(input.months) || input.months < 1 || input.months > 60) throw new BadRequestException({ code: 'months_invalid', message: 'Choose the period paid for.' });
    const paidAt = new Date(input.paidAt);
    if (Number.isNaN(paidAt.getTime())) throw new BadRequestException({ code: 'paid_at_invalid', message: 'Enter the payment date.' });
    if (!input.reason?.trim()) throw new BadRequestException({ code: 'reason_required', message: 'Say why.' });

    const request: ApplyRequest = { amount: input.amount, paidAt: paidAt.toISOString(), channel: input.channel, months: input.months, reason: input.reason };
    const claimed = await this.prisma.paymentProof.updateMany({
      where: { id: row.id, appliedAt: null, status: { in: ['submitted', 'under_review'] } },
      data: { appliedAt: new Date(), applyRequest: request as never },
    });
    if (!claimed.count) throw new ConflictException({ code: 'proof_applying', message: 'This proof is being applied, or stopped part-way. Open its recovery to see what happened.' });

    try {
      return await this.applySteps(row, id, request, ctx);
    } catch (e) {
      const { payment, periodApplied } = await this.progress(row.companyId, row.id, id);
      if (!payment && !periodApplied) {
        await this.prisma.paymentProof.updateMany({ where: { id: row.id, status: { not: 'approved' } }, data: { appliedAt: null, applyRequest: Prisma.DbNull } });
      }
      throw e;
    }
  }

  /** Each step recognises its own work: the payment by its reference, the period by the proof's mark, the decision by its status. */
  private async applySteps(row: Row, id: string, request: ApplyRequest, ctx: Actor, applyPeriod = true) {
    const company = binToUuid(row.companyId);
    const actor = { admin: ctx.admin, ip: ctx.ip ?? undefined } as never;
    await this.lifecycle.recordPayment(
      company,
      { amount: request.amount, paidAt: new Date(request.paidAt), channel: request.channel, reference: `proof:${id}`, note: request.reason, confirm: true },
      actor,
    );

    if (applyPeriod && !(await this.progress(row.companyId, row.id, id)).periodApplied) {
      const mark = async (tx: Prisma.TransactionClient) => {
        const moved = await tx.paymentProof.updateMany({ where: { id: row.id, periodAppliedAt: null }, data: { periodAppliedAt: new Date() } });
        // Rolls the second period back: two recoveries at once apply one.
        if (!moved.count) throw new PeriodAlreadyApplied();
      };
      const decision = { months: request.months, reason: request.reason };
      try {
        const sub = await this.prisma.subscription.findFirst({ where: { companyId: row.companyId }, select: { status: true } });
        const first = sub?.status === 'pending_activation' || sub?.status === 'rejected';
        // Someone else activating it first is answered `applied: false`, with no mark: this paid period still has to be added.
        const approved = first ? await this.lifecycle.approve(company, decision, actor, mark) : null;
        if (!approved?.applied) await this.lifecycle.extend(company, decision, actor, mark);
      } catch (e) {
        if (!(e instanceof PeriodAlreadyApplied)) throw e;
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const decided = await tx.paymentProof.updateMany({
        where: { id: row.id, status: { in: ['submitted', 'under_review'] } },
        data: { status: 'approved', months: applyPeriod ? request.months : null, decidedAt: new Date(), refusalReason: null },
      });
      if (decided.count) await this.record('payment_proof.approve', row.companyId, id, request.reason, { amount: request.amount, months: request.months, periodApplied: applyPeriod }, ctx, tx);
    });
    return view(await this.rowOf(id));
  }

  private async progress(companyId: Buffer, proofId: Buffer, id: string) {
    const [proof, payment] = await Promise.all([
      this.prisma.paymentProof.findUniqueOrThrow({ where: { id: proofId }, select: { periodAppliedAt: true } }),
      this.prisma.subscriptionPayment.findFirst({
        where: { companyId, reference: `proof:${id}` },
        select: { id: true, amount: true, paidAt: true, channel: true, confirmedAt: true },
      }),
    ]);
    return { payment, periodApplied: proof.periodAppliedAt !== null, periodAppliedAt: proof.periodAppliedAt };
  }

  /** What actually happened to a proof whose approval did not finish, and what may be done about it. Reads only. */
  async recovery(id: string) {
    const row = await this.rowOf(id);
    const full = await this.prisma.paymentProof.findUniqueOrThrow({ where: { id: row.id }, select: { appliedAt: true, applyRequest: true } });
    const { payment, periodApplied, periodAppliedAt } = await this.progress(row.companyId, row.id, id);
    const sub = await this.prisma.subscription.findFirst({
      where: { companyId: row.companyId },
      select: { status: true, currentPeriodEnd: true, isComplimentary: true, complimentaryUntil: true },
    });
    const open = row.status === 'submitted' || row.status === 'under_review';
    const stopped = open && full.appliedAt !== null;
    const settled = stopped && Date.now() - full.appliedAt!.getTime() >= RECOVERY_AFTER_MS;
    const known = full.applyRequest !== null;
    return {
      proofId: id,
      status: row.status,
      stopped,
      claimedAt: full.appliedAt?.toISOString() ?? null,
      /** Still inside the window where the approval may be running: nothing may be done yet. */
      mayStillBeRunning: stopped && !settled,
      request: full.applyRequest,
      paymentRecorded: payment !== null,
      payment: payment && { id: binToUuid(payment.id), amount: payment.amount.toString(), paidAt: payment.paidAt.toISOString(), channel: payment.channel, confirmed: payment.confirmedAt !== null },
      periodApplied,
      periodAppliedAt: periodAppliedAt?.toISOString() ?? null,
      subscription: sub && { status: sub.status, currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null, isComplimentary: sub.isComplimentary, complimentaryUntil: sub.complimentaryUntil?.toISOString() ?? null },
      actions: {
        complete: settled && known,
        // Only with the money recorded and no period from this proof: for a period the administrator gave some other way.
        closeWithoutPeriod: settled && known && payment !== null && !periodApplied,
        // Only when nothing happened, so the proof goes back to a fresh decision.
        release: settled && payment === null && !periodApplied,
      },
    };
  }

  /** Finishes the stored decision, never a new one. `closeWithoutPeriod` records it as decided and adds no period. */
  async completeRecovery(id: string, input: { reason: string; closeWithoutPeriod?: boolean }, ctx: Actor) {
    const reason = input.reason?.trim();
    if (!reason) throw new BadRequestException({ code: 'reason_required', message: 'Say why.' });
    const state = await this.recovery(id);
    if (!(input.closeWithoutPeriod ? state.actions.closeWithoutPeriod : state.actions.complete)) throw refused(state);
    const row = await this.rowOf(id);
    await this.record(
      input.closeWithoutPeriod ? 'payment_proof.recovery_close_without_period' : 'payment_proof.recovery_complete',
      row.companyId,
      id,
      reason,
      { found: { paymentRecorded: state.paymentRecorded, periodApplied: state.periodApplied, subscription: state.subscription } },
      ctx,
    );
    return this.applySteps(row, id, state.request as unknown as ApplyRequest, ctx, !input.closeWithoutPeriod);
  }

  /** Nothing was applied: the claim goes and the proof waits for a decision again. */
  async releaseRecovery(id: string, reason: string, ctx: Actor) {
    const why = reason?.trim();
    if (!why) throw new BadRequestException({ code: 'reason_required', message: 'Say why.' });
    const state = await this.recovery(id);
    if (!state.actions.release) throw refused(state);
    const row = await this.rowOf(id);
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.paymentProof.updateMany({
        where: { id: row.id, appliedAt: { not: null }, periodAppliedAt: null, status: { in: ['submitted', 'under_review'] } },
        data: { appliedAt: null, applyRequest: Prisma.DbNull },
      });
      if (!moved.count) throw refused(state);
      await this.record('payment_proof.recovery_release', row.companyId, id, why, { found: { paymentRecorded: false, periodApplied: false } }, ctx, tx);
    });
    return view(await this.rowOf(id));
  }

  private async rowOf(id: string): Promise<Row> {
    if (!isUuid(id)) throw new NotFoundException('Unknown proof');
    const row = await this.prisma.paymentProof.findUnique({ where: { id: uuidToBin(id) }, select: VIEW });
    if (!row) throw new NotFoundException('Unknown proof');
    return row;
  }

  private record(action: string, companyId: Buffer, proof: string, reason: string | null, after: Record<string, unknown>, ctx: Actor, db?: Prisma.TransactionClient) {
    return this.audit.record({
      admin: ctx.admin,
      action,
      targetType: 'Company',
      targetId: companyId,
      targetLabel: null,
      reason,
      after: { proof, ...after, outcome: 'applied' },
      ip: ctx.ip ?? null,
    }, db);
  }
}
