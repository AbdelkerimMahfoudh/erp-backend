import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type SeatAllocationKind, type SeatAllocationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformAuditService } from './platform-audit.service';
import { BillingService } from '../billing/billing.service';
import { CLOCK, type Clock } from '../entitlement/clock';
import { newUuidV7Bin, binToUuid } from '../common/utils/uuid.util';
import type { PlatformAdminIdentity } from './platform-admin.service';

/**
 * Seats beyond a store's included one, and additional stores (docs/21,
 * 2026-10-05; docs/68).
 *
 * The flow this file exists to keep honest:
 *
 *   Owner asks → the server prices it → it waits as `pending_payment` →
 *   an administrator confirms a REAL payment, with a reference → it is `paid`
 *   → the person it was asked for is activated once their contacts are proven.
 *
 * Nothing is granted by asking. Nothing is granted by a client-side amount.
 * Two confirmations of the same request produce one payment and one refusal,
 * because the transition is guarded by the row's `version` and the payment is
 * written in the same transaction as the status — if the status does not
 * move, the payment does not exist.
 *
 * **No provider is integrated.** Every payment row carries `providerVerified:
 * false`, and every confirmation is a named administrator saying they saw the
 * money arrive, against a reference anybody can later check.
 */

export interface SeatAllocationView {
  id: string;
  kind: SeatAllocationKind;
  status: SeatAllocationStatus;
  store: { id: string; name: string } | null;
  person: { id: string; name: string } | null;
  /** The requested store's name, for a store request. */
  label: string | null;
  monthlyAmount: number;
  currency: string;
  requestedBy: string;
  requestedAt: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  closedAt: string | null;
  closedBy: string | null;
  reason: string | null;
  payment: {
    id: string;
    amount: string;
    reference: string | null;
    paidAt: string;
    channel: string;
  } | null;
  version: number;
  /** Always false: no payment provider is integrated. Said on every row. */
  providerVerified: false;
}

export interface SeatRequestQueueItem extends SeatAllocationView {
  business: { id: string; name: string; publicStoreId: string };
}

interface ActorContext {
  admin: PlatformAdminIdentity;
  ip?: string | null;
}

/** A reference shorter than this is a typo, not a reference. */
export const PAYMENT_REFERENCE_MIN_LENGTH = 3;

const INCLUDE = {
  branch: { select: { id: true, name: true } },
  user: { select: { id: true, name: true } },
  payment: {
    select: {
      id: true,
      amount: true,
      reference: true,
      paidAt: true,
      channel: true,
    },
  },
} satisfies Prisma.SeatAllocationInclude;

type Row = Prisma.SeatAllocationGetPayload<{ include: typeof INCLUDE }>;

const CHANGED = () =>
  new ConflictException({
    code: 'seat_request_changed',
    message: 'Somebody else changed this request. Refresh and try again.',
  });

@Injectable()
export class SeatAllocationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: PlatformAuditService,
    private readonly billing: BillingService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  view(row: Row): SeatAllocationView {
    return {
      id: binToUuid(row.id),
      kind: row.kind,
      status: row.status,
      store: row.branch ? { id: binToUuid(row.branch.id), name: row.branch.name } : null,
      person: row.user ? { id: binToUuid(row.user.id), name: row.user.name } : null,
      label: row.label,
      monthlyAmount: row.monthlyAmount,
      currency: row.currency,
      requestedBy: row.requestedBy,
      requestedAt: row.requestedAt.toISOString(),
      confirmedBy: row.confirmedBy,
      confirmedAt: row.confirmedAt?.toISOString() ?? null,
      closedAt: row.closedAt?.toISOString() ?? null,
      closedBy: row.closedBy,
      reason: row.reason,
      payment: row.payment
        ? {
            id: binToUuid(row.payment.id),
            amount: row.payment.amount.toString(),
            reference: row.payment.reference,
            paidAt: row.payment.paidAt.toISOString(),
            channel: row.payment.channel,
          }
        : null,
      version: row.version,
      providerVerified: false,
    };
  }

  private async subscriptionOf(companyId: Buffer) {
    const sub = await this.prisma.subscription.findFirst({
      where: { companyId },
      include: { company: { select: { name: true, publicStoreId: true } } },
    });
    if (!sub) throw new NotFoundException('Unknown business');
    return sub;
  }

  /** Seats the company holds: paid or granted. */
  private async heldSeats(companyId: Buffer): Promise<number> {
    return this.prisma.seatAllocation.count({
      where: { companyId, kind: 'seat', status: { in: ['paid', 'granted'] } },
    });
  }

  private async load(allocationId: Buffer): Promise<Row> {
    const row = await this.prisma.seatAllocation.findUnique({
      where: { id: allocationId },
      include: INCLUDE,
    });
    if (!row) throw new NotFoundException('Unknown request');
    return row;
  }

  // ── asking ───────────────────────────────────────────────────────────────

  /**
   * One more seat at a store, priced by today's plan and waiting for payment.
   *
   * Idempotent per person: asking twice for the same person at the same store
   * returns the request that already exists, so a retried tap or a second
   * Owner cannot queue two charges for one seat.
   */
  async requestSeat(
    companyId: Buffer,
    input: {
      branchId: Buffer;
      userId?: Buffer | null;
      requestedBy: string;
      note?: string | null;
    },
  ): Promise<{ allocation: SeatAllocationView; created: boolean }> {
    const sub = await this.subscriptionOf(companyId);
    const branch = await this.prisma.branch.findFirst({
      where: { id: input.branchId, companyId, isActive: true, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!branch) throw new NotFoundException('Unknown store');

    if (input.userId) {
      const existing = await this.prisma.seatAllocation.findFirst({
        where: {
          companyId,
          kind: 'seat',
          branchId: branch.id,
          userId: input.userId,
          status: { in: ['pending_payment', 'paid', 'granted'] },
        },
        include: INCLUDE,
      });
      if (existing) return { allocation: this.view(existing), created: false };
    }

    const plan = await this.billing.planAt(this.clock.now());
    const row = await this.prisma.seatAllocation.create({
      data: {
        id: newUuidV7Bin(),
        companyId,
        subscriptionId: sub.id,
        branchId: branch.id,
        userId: input.userId ?? null,
        kind: 'seat',
        status: 'pending_payment',
        monthlyAmount: plan.current.extraStaffMonthly,
        requestedBy: input.requestedBy.slice(0, 160),
        reason: input.note?.slice(0, 500) ?? null,
      },
      include: INCLUDE,
    });

    await this.prisma.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId,
        subscriptionId: sub.id,
        kind: 'seat_requested',
        note: `Additional seat at ${branch.name}${row.user ? ` for ${row.user.name}` : ''}: ${row.monthlyAmount} MRU per month, awaiting payment.`.slice(
          0,
          255,
        ),
        branchesAfter: sub.subscribedBranchCount,
        seatsAfter: await this.heldSeats(companyId),
        actor: input.requestedBy.slice(0, 120),
      },
    });

    return { allocation: this.view(row), created: true };
  }

  /**
   * One more store, priced by today's plan and waiting for payment.
   *
   * The store itself is created only when the payment is confirmed — asking
   * creates nothing a shop could sell from.
   */
  async requestStore(
    companyId: Buffer,
    input: { name: string; requestedBy: string },
  ): Promise<{ allocation: SeatAllocationView; created: boolean }> {
    const sub = await this.subscriptionOf(companyId);
    const name = (input.name ?? '').trim();
    if (!name) throw new BadRequestException('Name the store.');
    if (name.length > 160) throw new BadRequestException('A store name is at most 160 characters.');

    const clash = await this.prisma.branch.findFirst({
      where: { companyId, name },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException({
        code: 'store_name_in_use',
        message: 'A store with that name already exists.',
      });
    }
    const pendingSame = await this.prisma.seatAllocation.findFirst({
      where: {
        companyId,
        kind: 'store',
        label: name,
        status: 'pending_payment',
      },
      include: INCLUDE,
    });
    if (pendingSame) return { allocation: this.view(pendingSame), created: false };

    const plan = await this.billing.planAt(this.clock.now());
    const row = await this.prisma.seatAllocation.create({
      data: {
        id: newUuidV7Bin(),
        companyId,
        subscriptionId: sub.id,
        kind: 'store',
        status: 'pending_payment',
        label: name,
        monthlyAmount: plan.current.branchMonthly,
        requestedBy: input.requestedBy.slice(0, 160),
      },
      include: INCLUDE,
    });

    await this.prisma.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId,
        subscriptionId: sub.id,
        kind: 'store_requested',
        note: `Additional store "${name}": ${row.monthlyAmount} MRU per month, awaiting payment.`.slice(0, 255),
        branchesAfter: sub.subscribedBranchCount,
        actor: input.requestedBy.slice(0, 120),
      },
    });

    return { allocation: this.view(row), created: true };
  }

  // ── deciding ─────────────────────────────────────────────────────────────

  /**
   * An administrator says the money for this request arrived.
   *
   * A reference is required: a confirmation nobody can check against a bank
   * statement or a receipt is not evidence. The payment row and the status
   * change commit together; the `version` guard makes a second confirmation —
   * a retry, or a colleague a second later — a refusal, never a second payment.
   * A request already paid answers `applied: false` with what it has, so a
   * dropped response can be retried safely.
   *
   * For a store request, the store is created here, the company's subscribed
   * store count rises by one, and every Owner is assigned to it so the shop
   * can use it at once. A seat request grants nothing by itself: the caller
   * then asks the activation service whether the person may now be activated.
   */
  async confirmPayment(
    allocationId: Buffer,
    input: {
      amount: string;
      paidAt: Date;
      channel?: 'manual' | 'bank_transfer' | 'mobile_money';
      reference: string;
      note?: string;
      expectedVersion?: number;
    },
    ctx: ActorContext,
  ): Promise<{
    allocation: SeatAllocationView;
    applied: boolean;
    paymentId: string | null;
  }> {
    const reference = (input.reference ?? '').trim();
    if (reference.length < PAYMENT_REFERENCE_MIN_LENGTH) {
      throw new BadRequestException({
        code: 'reference_required',
        message: 'Enter the payment reference — the transfer id or receipt number — before confirming.',
      });
    }
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Enter the amount that was actually paid.');
    }
    if (Number.isNaN(input.paidAt.getTime()) || input.paidAt.getTime() > this.clock.now().getTime() + 5 * 60_000) {
      throw new BadRequestException('The payment date cannot be in the future.');
    }

    const before = await this.load(allocationId);
    // A stale version is a colleague's decision the caller has not seen: told to refresh,
    // whatever the state. Without a version, a retry that finds the work done is a no-op.
    if (input.expectedVersion !== undefined && input.expectedVersion !== before.version) throw CHANGED();
    if (before.status === 'paid') {
      return {
        allocation: this.view(before),
        applied: false,
        paymentId: before.payment ? binToUuid(before.payment.id) : null,
      };
    }
    if (before.status !== 'pending_payment') {
      throw new BadRequestException(
        `This request was ${before.status}; only a request awaiting payment can be confirmed.`,
      );
    }

    const sub = await this.subscriptionOf(before.companyId);
    const now = this.clock.now();

    const result = await this.prisma.$transaction(async (tx) => {
      const payment = await tx.subscriptionPayment.create({
        data: {
          id: newUuidV7Bin(),
          companyId: before.companyId,
          subscriptionId: sub.id,
          amount: new Prisma.Decimal(input.amount),
          currency: 'MRU',
          paidAt: input.paidAt,
          channel: input.channel ?? 'manual',
          reference: reference.slice(0, 120),
          note: input.note?.slice(0, 500) ?? null,
          recordedBy: ctx.admin.email,
          confirmedBy: ctx.admin.email,
          confirmedAt: now,
        },
      });

      // The guard. If the row moved under us, this writes nothing — and the
      // thrown conflict rolls the payment back with it.
      const moved = await tx.seatAllocation.updateMany({
        where: {
          id: allocationId,
          status: 'pending_payment',
          version: before.version,
        },
        data: {
          status: 'paid',
          paymentId: payment.id,
          confirmedBy: ctx.admin.email,
          confirmedAt: now,
          version: { increment: 1 },
        },
      });
      if (moved.count !== 1) throw CHANGED();

      let storeName: string | null = null;
      if (before.kind === 'store') {
        storeName = before.label ?? 'New store';
        let branch: { id: Buffer };
        try {
          branch = await tx.branch.create({
            data: {
              id: newUuidV7Bin(),
              companyId: before.companyId,
              name: storeName,
              type: 'store',
            },
            select: { id: true },
          });
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            throw new ConflictException({
              code: 'store_name_in_use',
              message: 'A store with that name already exists.',
            });
          }
          throw e;
        }
        // Every Owner works at every store: assign them so the shop can use it at once.
        const owners = await tx.userBranch.findMany({
          where: {
            companyId: before.companyId,
            role: { key: 'owner' },
            user: { deletedAt: null },
          },
          distinct: ['userId'],
          select: { userId: true, roleId: true },
        });
        for (const o of owners) {
          await tx.userBranch.create({
            data: {
              id: newUuidV7Bin(),
              companyId: before.companyId,
              userId: o.userId,
              branchId: branch.id,
              roleId: o.roleId,
            },
          });
        }
        await tx.subscription.update({
          where: { id: sub.id },
          data: {
            subscribedBranchCount: { increment: 1 },
            version: { increment: 1 },
          },
        });
        await tx.subscriptionEvent.create({
          data: {
            id: newUuidV7Bin(),
            companyId: before.companyId,
            subscriptionId: sub.id,
            kind: 'branches_changed',
            note: `Store "${storeName}" opened after payment ${reference}.`.slice(0, 255),
            branchesAfter: sub.subscribedBranchCount + 1,
            actor: ctx.admin.email,
          },
        });
      }

      await tx.subscriptionEvent.create({
        data: {
          id: newUuidV7Bin(),
          companyId: before.companyId,
          subscriptionId: sub.id,
          kind: 'seat_paid',
          note: `${before.kind === 'store' ? 'Store' : `Seat at ${before.branch?.name ?? 'a store'}`}: payment confirmed, reference ${reference}.`.slice(
            0,
            255,
          ),
          branchesAfter: sub.subscribedBranchCount + (before.kind === 'store' ? 1 : 0),
          actor: ctx.admin.email,
        },
      });

      return { payment, storeName };
    });

    await this.audit.record({
      admin: ctx.admin,
      action: before.kind === 'store' ? 'store.payment_confirm' : 'seat.payment_confirm',
      targetType: 'Company',
      targetId: before.companyId,
      targetLabel: sub.company.name,
      reason: input.note ?? null,
      before: {
        requestId: binToUuid(allocationId),
        status: 'pending_payment',
        version: before.version,
      },
      after: {
        requestId: binToUuid(allocationId),
        status: 'paid',
        paymentId: binToUuid(result.payment.id),
        amount: input.amount,
        currency: 'MRU',
        channel: result.payment.channel,
        reference,
        ...(result.storeName ? { storeOpened: result.storeName } : {}),
        ...(before.branch ? { store: before.branch.name } : {}),
        ...(before.user ? { person: before.user.name } : {}),
        // Said explicitly, so nobody reading the log later infers otherwise.
        providerVerified: false,
      },
      ip: ctx.ip ?? null,
    });

    // A seat or a store added mid-period costs the whole month, now.
    await this.billing.assessNow(before.companyId);

    const after = await this.load(allocationId);
    return {
      allocation: this.view(after),
      applied: true,
      paymentId: binToUuid(result.payment.id),
    };
  }

  /** Refuse a request awaiting payment, with a reason. Nothing was ever granted by it. */
  async refuse(
    allocationId: Buffer,
    input: { reason: string; expectedVersion?: number },
    ctx: ActorContext,
  ): Promise<{ allocation: SeatAllocationView; applied: boolean }> {
    if (!input.reason?.trim()) throw new BadRequestException('Say why this request is refused.');
    const before = await this.load(allocationId);
    if (input.expectedVersion !== undefined && input.expectedVersion !== before.version) throw CHANGED();
    if (before.status === 'refused') return { allocation: this.view(before), applied: false };
    if (before.status !== 'pending_payment') {
      throw new BadRequestException(
        `This request was ${before.status}; only a request awaiting payment can be refused.`,
      );
    }
    return this.close(before, 'refused', input.reason, ctx.admin.email, {
      admin: ctx.admin,
      action: 'seat.refuse',
      ip: ctx.ip ?? null,
    });
  }

  /**
   * Give a held seat back. Nothing is refunded this period, and nobody is
   * deactivated: a store left with more people than seats is reported, and the
   * Owner decides who stays.
   */
  async release(
    allocationId: Buffer,
    input: { reason: string; expectedVersion?: number },
    ctx: ActorContext,
  ): Promise<{ allocation: SeatAllocationView; applied: boolean }> {
    if (!input.reason?.trim()) throw new BadRequestException('Say why this seat is released.');
    const before = await this.load(allocationId);
    if (input.expectedVersion !== undefined && input.expectedVersion !== before.version) throw CHANGED();
    if (before.status === 'released') return { allocation: this.view(before), applied: false };
    if (before.status !== 'paid' && before.status !== 'granted') {
      throw new BadRequestException(`This request was ${before.status}; only a held seat can be released.`);
    }
    if (before.kind === 'store') {
      throw new BadRequestException('A store is not released here: archive the store in the shop instead.');
    }
    return this.close(before, 'released', input.reason, ctx.admin.email, {
      admin: ctx.admin,
      action: 'seat.release',
      ip: ctx.ip ?? null,
    });
  }

  /** The Owner withdraws a request nobody has paid yet. Only their own company's, and only pending ones. */
  async withdraw(
    companyId: Buffer,
    allocationId: Buffer,
    actor: string,
  ): Promise<{ allocation: SeatAllocationView; applied: boolean }> {
    const before = await this.load(allocationId);
    if (!before.companyId.equals(companyId)) throw new NotFoundException('Unknown request');
    if (before.status === 'released') return { allocation: this.view(before), applied: false };
    if (before.status !== 'pending_payment') {
      throw new BadRequestException('Only a request still awaiting payment can be withdrawn.');
    }
    return this.close(before, 'released', 'Withdrawn by the business before payment.', actor, null);
  }

  private async close(
    before: Row,
    status: 'refused' | 'released',
    reason: string,
    closedBy: string,
    audit: {
      admin: PlatformAdminIdentity;
      action: string;
      ip: string | null;
    } | null,
  ): Promise<{ allocation: SeatAllocationView; applied: boolean }> {
    const now = this.clock.now();
    const moved = await this.prisma.seatAllocation.updateMany({
      where: { id: before.id, status: before.status, version: before.version },
      data: {
        status,
        closedAt: now,
        closedBy: closedBy.slice(0, 160),
        reason: reason.slice(0, 500),
        version: { increment: 1 },
      },
    });
    if (moved.count !== 1) throw CHANGED();

    await this.prisma.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId: before.companyId,
        subscriptionId: before.subscriptionId,
        kind: 'seat_closed',
        note: `${before.kind === 'store' ? `Store request "${before.label ?? ''}"` : `Seat at ${before.branch?.name ?? 'a store'}`} ${status}: ${reason}`.slice(
          0,
          255,
        ),
        seatsAfter: await this.heldSeats(before.companyId),
        actor: closedBy.slice(0, 120),
      },
    });

    if (audit) {
      const company = await this.prisma.company.findUnique({
        where: { id: before.companyId },
        select: { name: true },
      });
      await this.audit.record({
        admin: audit.admin,
        action: audit.action,
        targetType: 'Company',
        targetId: before.companyId,
        targetLabel: company?.name ?? null,
        reason,
        before: {
          requestId: binToUuid(before.id),
          status: before.status,
          version: before.version,
        },
        after: { requestId: binToUuid(before.id), status },
        ip: audit.ip,
      });
    }

    const after = await this.load(before.id);
    return { allocation: this.view(after), applied: true };
  }

  // ── reading ──────────────────────────────────────────────────────────────

  async listForCompany(companyId: Buffer): Promise<SeatAllocationView[]> {
    const rows = await this.prisma.seatAllocation.findMany({
      where: { companyId },
      include: INCLUDE,
      orderBy: { requestedAt: 'desc' },
      take: 200,
    });
    return rows.map((r) => this.view(r));
  }

  /** The platform's queue: what is waiting for a decision, oldest first. */
  async queue(status: SeatAllocationStatus = 'pending_payment'): Promise<SeatRequestQueueItem[]> {
    const rows = await this.prisma.seatAllocation.findMany({
      where: { status },
      include: {
        ...INCLUDE,
        company: { select: { id: true, name: true, publicStoreId: true } },
      },
      orderBy: { requestedAt: status === 'pending_payment' ? 'asc' : 'desc' },
      take: 200,
    });
    return rows.map((r) => ({
      ...this.view(r),
      business: {
        id: binToUuid(r.company.id),
        name: r.company.name,
        publicStoreId: r.company.publicStoreId,
      },
    }));
  }
}
