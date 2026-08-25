import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { newUuidV7Bin, uuidToBin, binToUuid, isUuid } from '../common/utils/uuid.util';
import { PlatformAuditService } from './platform-audit.service';
import type { PlatformAdminIdentity } from './platform-admin.service';

/**
 * The subscription lifecycle, driven by a platform administrator.
 *
 * **This does not compute money.** There is no plan price and no per-seat
 * charge anywhere on the server — Milestone K's canonical decision is that
 * there is one functional plan and entitlement is about *access*, not
 * invoicing. So nothing here totals anything, and no screen may either. A
 * recorded payment carries the amount a human typed, and that is the only
 * figure in the system.
 *
 * Two things are kept scrupulously apart:
 *
 *  - an **administrative grant** — we gave this shop access, for a reason, for
 *    a period. No money changed hands and the record says so.
 *  - a **payment** — a named person says they saw this money arrive.
 *
 * Collapsing them would let a test activation look, months later, exactly like
 * a shop that paid. That is the failure this whole design is arranged around.
 */

export type LifecycleAction =
  | 'activate_grant'
  | 'extend'
  | 'suspend'
  | 'reinstate'
  | 'cancel'
  | 'payment_recorded'
  | 'payment_confirmed';

interface ActorContext {
  admin: PlatformAdminIdentity;
  ip?: string | null;
}

@Injectable()
export class SubscriptionLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: PlatformAuditService,
  ) {}

  private companyIdOf(companyId: string): Buffer {
    if (!isUuid(companyId)) throw new BadRequestException('Unknown business');
    return uuidToBin(companyId);
  }

  private async loadOrThrow(id: Buffer) {
    const sub = await this.prisma.subscription.findFirst({
      where: { companyId: id },
      include: { company: { select: { name: true, publicStoreId: true } } },
    });
    if (!sub) throw new NotFoundException('Unknown business');
    return sub;
  }

  /** The shape written into the audit trail. Never anything secret. */
  private snapshot(sub: {
    status: SubscriptionStatus;
    currentPeriodEnd: Date | null;
    isComplimentary: boolean;
    complimentaryUntil: Date | null;
    subscribedBranchCount: number;
    additionalSeats: number;
    version: number;
  }) {
    return {
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
      isComplimentary: sub.isComplimentary,
      complimentaryUntil: sub.complimentaryUntil?.toISOString() ?? null,
      subscribedBranchCount: sub.subscribedBranchCount,
      additionalSeats: sub.additionalSeats,
      version: sub.version,
    };
  }

  /**
   * Apply one transition, exactly once.
   *
   * Optimistic concurrency on `version`: two administrators activating the same
   * pending business at the same moment produce one winner and one
   * `ConflictException`, and the loser is told to refresh rather than silently
   * applying the transition twice. The alternative — last write wins — would
   * double an extension without anybody noticing.
   *
   * `expectedVersion` is optional so an idempotent retry from the same
   * administrator can be recognised by its outcome instead: if the subscription
   * already looks exactly as this call would leave it, the call is a no-op that
   * returns the winning state. That is what makes a network retry safe.
   */
  private async transition<T extends Record<string, unknown>>(
    companyId: Buffer,
    expectedVersion: number | undefined,
    data: T,
  ) {
    const where: Prisma.SubscriptionWhereUniqueInput & { version?: number } = {
      companyId,
    } as never;

    try {
      return await this.prisma.subscription.update({
        where:
          expectedVersion === undefined
            ? ({ companyId } as never)
            : ({ companyId, version: expectedVersion } as never),
        data: { ...data, version: { increment: 1 } } as never,
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new ConflictException({
          code: 'subscription_changed',
          message: 'Somebody else changed this subscription. Refresh and try again.',
        });
      }
      throw e;
    }
    void where;
  }

  /**
   * Activate a pending (or lapsed) business as an **administrative grant**.
   *
   * This is the manual testing path, and it is recorded honestly: no payment
   * row is created, `isComplimentary` is set, and the reason and duration are
   * written into both the subscription-event trail and the platform audit log.
   * Nothing anywhere claims a provider confirmed anything, because none did.
   */
  async activateByGrant(
    companyId: string,
    input: { days: number; reason: string; expectedVersion?: number },
    ctx: ActorContext,
  ) {
    if (!Number.isInteger(input.days) || input.days < 1 || input.days > 3650) {
      throw new BadRequestException('Give a duration between 1 and 3650 days.');
    }
    if (!input.reason?.trim()) {
      throw new BadRequestException('A grant needs a reason — it is the whole record.');
    }

    const id = this.companyIdOf(companyId);
    const before = await this.loadOrThrow(id);

    const until = new Date(Date.now() + input.days * 24 * 60 * 60 * 1000);

    /*
     * Idempotent retry.
     *
     * If this business is already granted, already activated, and the grant
     * runs to about the same moment, the call has already happened — almost
     * certainly a retry after a dropped response. Return the winning state
     * rather than stacking a second grant on top.
     */
    const alreadyDone =
      before.status === 'activated' &&
      before.isComplimentary &&
      before.complimentaryUntil !== null &&
      Math.abs(before.complimentaryUntil.getTime() - until.getTime()) < 60_000;

    if (alreadyDone) {
      return { subscription: before, applied: false };
    }

    const after = await this.transition(id, input.expectedVersion, {
      status: 'activated' as SubscriptionStatus,
      isComplimentary: true,
      complimentaryReason: input.reason.slice(0, 255),
      complimentaryUntil: until,
    });

    await this.prisma.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId: id,
        subscriptionId: before.id,
        // The kind says what it was. Nobody reading this later can mistake a
        // grant for money that arrived.
        kind: 'administrative_grant',
        note: input.reason.slice(0, 255),
        periodEndAfter: after.currentPeriodEnd,
        branchesAfter: after.subscribedBranchCount,
        seatsAfter: after.additionalSeats,
        actor: ctx.admin.email,
      },
    });

    await this.audit.record({
      admin: ctx.admin,
      action: 'subscription.activate_grant',
      targetType: 'Company',
      targetId: id,
      targetLabel: before.company.name,
      reason: input.reason,
      before: this.snapshot(before),
      after: { ...this.snapshot(after), grantDays: input.days, paymentRecorded: false },
      ip: ctx.ip ?? null,
    });

    return { subscription: after, applied: true };
  }

  /** Extend a paid period. Never touches the grant fields. */
  async extend(
    companyId: string,
    input: { months: number; reason?: string; expectedVersion?: number },
    ctx: ActorContext,
  ) {
    if (!Number.isInteger(input.months) || input.months < 1 || input.months > 60) {
      throw new BadRequestException('Extend by between 1 and 60 months.');
    }

    const id = this.companyIdOf(companyId);
    const before = await this.loadOrThrow(id);

    // From the later of now and the current end, so extending a lapsed
    // subscription does not silently backdate the new period into the past.
    const from =
      before.currentPeriodEnd && before.currentPeriodEnd.getTime() > Date.now()
        ? new Date(before.currentPeriodEnd)
        : new Date();
    const end = new Date(from);
    end.setMonth(end.getMonth() + input.months);

    const after = await this.transition(id, input.expectedVersion, {
      status: 'activated' as SubscriptionStatus,
      currentPeriodEnd: end,
    });

    await this.prisma.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId: id,
        subscriptionId: before.id,
        kind: 'extended',
        note: input.reason?.slice(0, 255) ?? null,
        periodEndAfter: end,
        branchesAfter: after.subscribedBranchCount,
        seatsAfter: after.additionalSeats,
        actor: ctx.admin.email,
      },
    });

    await this.audit.record({
      admin: ctx.admin,
      action: 'subscription.extend',
      targetType: 'Company',
      targetId: id,
      targetLabel: before.company.name,
      reason: input.reason ?? null,
      before: this.snapshot(before),
      after: { ...this.snapshot(after), months: input.months },
      ip: ctx.ip ?? null,
    });

    return { subscription: after, applied: true };
  }

  /** Stop a business, with a reason. High impact — the controller steps up first. */
  async suspend(
    companyId: string,
    input: { reason: string; expectedVersion?: number },
    ctx: ActorContext,
  ) {
    if (!input.reason?.trim()) {
      throw new BadRequestException('A suspension needs a reason.');
    }
    const id = this.companyIdOf(companyId);
    const before = await this.loadOrThrow(id);

    if (before.status === 'suspended') {
      return { subscription: before, applied: false };
    }

    const after = await this.transition(id, input.expectedVersion, {
      status: 'suspended' as SubscriptionStatus,
    });

    await this.prisma.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId: id,
        subscriptionId: before.id,
        kind: 'suspended',
        note: input.reason.slice(0, 255),
        periodEndAfter: after.currentPeriodEnd,
        branchesAfter: after.subscribedBranchCount,
        seatsAfter: after.additionalSeats,
        actor: ctx.admin.email,
      },
    });

    await this.audit.record({
      admin: ctx.admin,
      action: 'subscription.suspend',
      targetType: 'Company',
      targetId: id,
      targetLabel: before.company.name,
      reason: input.reason,
      before: this.snapshot(before),
      after: this.snapshot(after),
      ip: ctx.ip ?? null,
    });

    return { subscription: after, applied: true };
  }

  /** Undo a suspension. The dates decide again from here. */
  async reinstate(
    companyId: string,
    input: { reason?: string; expectedVersion?: number },
    ctx: ActorContext,
  ) {
    const id = this.companyIdOf(companyId);
    const before = await this.loadOrThrow(id);

    if (before.status !== 'suspended') {
      return { subscription: before, applied: false };
    }

    const after = await this.transition(id, input.expectedVersion, {
      status: 'activated' as SubscriptionStatus,
    });

    await this.prisma.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId: id,
        subscriptionId: before.id,
        kind: 'reinstated',
        note: input.reason?.slice(0, 255) ?? null,
        periodEndAfter: after.currentPeriodEnd,
        branchesAfter: after.subscribedBranchCount,
        seatsAfter: after.additionalSeats,
        actor: ctx.admin.email,
      },
    });

    await this.audit.record({
      admin: ctx.admin,
      action: 'subscription.reinstate',
      targetType: 'Company',
      targetId: id,
      targetLabel: before.company.name,
      reason: input.reason ?? null,
      before: this.snapshot(before),
      after: this.snapshot(after),
      ip: ctx.ip ?? null,
    });

    return { subscription: after, applied: true };
  }

  /** End it. Nothing is deleted — the history is the point. */
  async cancel(
    companyId: string,
    input: { reason: string; expectedVersion?: number },
    ctx: ActorContext,
  ) {
    if (!input.reason?.trim()) throw new BadRequestException('A cancellation needs a reason.');

    const id = this.companyIdOf(companyId);
    const before = await this.loadOrThrow(id);
    if (before.status === 'cancelled') return { subscription: before, applied: false };

    const after = await this.transition(id, input.expectedVersion, {
      status: 'cancelled' as SubscriptionStatus,
    });

    await this.prisma.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId: id,
        subscriptionId: before.id,
        kind: 'cancelled',
        note: input.reason.slice(0, 255),
        periodEndAfter: after.currentPeriodEnd,
        branchesAfter: after.subscribedBranchCount,
        seatsAfter: after.additionalSeats,
        actor: ctx.admin.email,
      },
    });

    await this.audit.record({
      admin: ctx.admin,
      action: 'subscription.cancel',
      targetType: 'Company',
      targetId: id,
      targetLabel: before.company.name,
      reason: input.reason,
      before: this.snapshot(before),
      after: this.snapshot(after),
      ip: ctx.ip ?? null,
    });

    return { subscription: after, applied: true };
  }

  /**
   * Record money that actually arrived.
   *
   * Separate from activation on purpose: recording a payment does not extend
   * anything by itself. An administrator records what they saw, then extends
   * the period as a distinct, separately audited act. Bundling them would mean
   * a mistyped amount silently moved an expiry date.
   *
   * **No provider is contacted.** `confirmedBy` means "this named person says
   * the money is real".
   */
  async recordPayment(
    companyId: string,
    input: {
      amount: string;
      paidAt: Date;
      channel?: 'manual' | 'bank_transfer' | 'mobile_money';
      reference?: string;
      note?: string;
      confirm?: boolean;
    },
    ctx: ActorContext,
  ) {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Enter the amount that was actually paid.');
    }

    const id = this.companyIdOf(companyId);
    const sub = await this.loadOrThrow(id);

    const payment = await this.prisma.subscriptionPayment.create({
      data: {
        id: newUuidV7Bin(),
        companyId: id,
        subscriptionId: sub.id,
        amount: new Prisma.Decimal(input.amount),
        currency: 'MRU',
        paidAt: input.paidAt,
        channel: input.channel ?? 'manual',
        reference: input.reference?.slice(0, 120) ?? null,
        note: input.note?.slice(0, 500) ?? null,
        recordedBy: ctx.admin.email,
        confirmedBy: input.confirm ? ctx.admin.email : null,
        confirmedAt: input.confirm ? new Date() : null,
      },
    });

    await this.audit.record({
      admin: ctx.admin,
      action: input.confirm ? 'payment.record_and_confirm' : 'payment.record',
      targetType: 'Company',
      targetId: id,
      targetLabel: sub.company.name,
      reason: input.note ?? null,
      after: {
        paymentId: binToUuid(payment.id),
        amount: input.amount,
        currency: 'MRU',
        channel: payment.channel,
        reference: payment.reference,
        // Said explicitly, so nobody reading the log later infers otherwise.
        providerVerified: false,
      },
      ip: ctx.ip ?? null,
    });

    return payment;
  }

  /** The complete, ordered story of one subscription. */
  async timeline(companyId: string) {
    const id = this.companyIdOf(companyId);
    await this.loadOrThrow(id);

    const [events, payments] = await Promise.all([
      this.prisma.subscriptionEvent.findMany({
        where: { companyId: id },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      this.prisma.subscriptionPayment.findMany({
        where: { companyId: id },
        orderBy: { paidAt: 'desc' },
        take: 200,
      }),
    ]);

    return {
      events: events.map((e) => ({
        id: binToUuid(e.id),
        kind: e.kind,
        note: e.note,
        actor: e.actor,
        periodEndAfter: e.periodEndAfter?.toISOString() ?? null,
        createdAt: e.createdAt.toISOString(),
      })),
      /** Kept in its own list, so a grant can never be read as money. */
      payments: payments.map((p) => ({
        id: binToUuid(p.id),
        amount: p.amount.toString(),
        currency: p.currency,
        channel: p.channel,
        reference: p.reference,
        note: p.note,
        paidAt: p.paidAt.toISOString(),
        recordedBy: p.recordedBy,
        confirmedBy: p.confirmedBy,
        confirmedAt: p.confirmedAt?.toISOString() ?? null,
        providerVerified: false,
      })),
    };
  }
}
