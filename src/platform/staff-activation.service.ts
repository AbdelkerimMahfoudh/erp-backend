import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CLOCK, type Clock } from '../entitlement/clock';
import { SeatAllocationService } from './seat-allocation.service';
import { TrialEndRoll } from './trial/trial-end-roll';
import {
  activateIfReadyTx,
  evaluateActivation,
  unique,
  type ActivationDb,
  type ActivationOutcome,
} from './staff-activation-rules';

export type { ActivationOutcome, PendingReason } from './staff-activation-rules';

/**
 * Whether a staff account may become usable, and making it so (docs/21,
 * 2026-10-05).
 *
 * An account an Owner created from Team starts PENDING and is activated only
 * by the server, only here, and only when every condition holds at once:
 *
 *  - every contact the Owner selected has been proven by the person who holds
 *    it — the email if an email was given, the number if a number was given,
 *    both if both;
 *  - at each store the person is assigned to, a seat is held for them: the
 *    store's included seat, a seat paid for and confirmed by an administrator,
 *    or a granted one.
 *
 * The two may complete in either order. Neither is skipped for an older client
 * or a direct API call, because the only thing that flips `is_active` for such
 * an account is this service — and sign-in refuses an inactive account before
 * it looks at the password.
 *
 * When a seat is wanted and none is free, the request is created here, priced
 * by the server, and the account waits for the payment to be confirmed.
 */

@Injectable()
export class StaffActivationService {
  /** A seat paid for during a free trial that has ended is put in force before anybody is judged on it (D176). */
  private readonly trialEnd: TrialEndRoll;

  constructor(
    private readonly prisma: PrismaService,
    private readonly allocations: SeatAllocationService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.trialEnd = new TrialEndRoll(prisma, clock);
  }

  /** What still stands between this account and activation. Reads only. */
  async pendingFor(userId: Buffer): Promise<ActivationOutcome> {
    const e = await evaluateActivation(this.prisma, userId);
    return {
      activated: e.activated,
      alreadyActive: e.alreadyActive,
      pending: e.pending,
    };
  }

  /**
   * Activate the account if every condition holds; otherwise say what is
   * missing, and turn a missing seat into a priced request.
   *
   * The activation itself runs under a row lock on the company's subscription,
   * re-checking the seats inside the lock, so two people verifying their codes
   * at the same instant cannot both take the last seat.
   */
  async tryActivate(userId: Buffer, actor: string): Promise<ActivationOutcome> {
    // What the free trial's end owes the business comes first (never waiting on the lock): the person is then judged on
    // the seats really in force.
    const person = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: { companyId: true } });
    if (person) await this.trialEnd.applyIfDue(person.companyId);
    const first = await evaluateActivation(this.prisma, userId);
    if (first.alreadyActive) return { activated: true, alreadyActive: true, pending: [] };
    if (!first.eligible) return { activated: false, alreadyActive: false, pending: [] };

    if (first.storesWithoutSeat.length > 0 && first.row) {
      // No free seat: the server prices one and the account waits for payment.
      for (const branchId of first.storesWithoutSeat) {
        await this.allocations.requestSeat(first.row.companyId, {
          branchId,
          userId,
          requestedBy: actor,
          note: 'Requested by the server: no seat was free at this store when the account was ready.',
        });
      }
      const pending = first.pending.filter((p) => p !== 'seat_unavailable');
      pending.push('seat_payment');
      return {
        activated: false,
        alreadyActive: false,
        pending: unique(pending),
      };
    }
    if (first.pending.length > 0) {
      return { activated: false, alreadyActive: false, pending: first.pending };
    }

    const companyId = first.row!.companyId;
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      // Serialise activations per company: the census must not race itself.
      await tx.$queryRaw`SELECT id FROM subscriptions WHERE company_id = ${companyId} FOR UPDATE`;
      return activateIfReadyTx(tx as unknown as ActivationDb, userId, now, actor);
    });
  }

  /**
   * Activate inside the caller's transaction, which already holds the company's subscription lock — an employee's
   * invitation confirmation, where the verified number, the consent and the account commit together (D214). It
   * activates only; a missing seat is left to {@link tryActivate} after the commit.
   */
  activateInTx(tx: Prisma.TransactionClient, userId: Buffer, actor: string): Promise<ActivationOutcome> {
    return activateIfReadyTx(tx as unknown as ActivationDb, userId, this.clock.now(), actor);
  }

  /**
   * Whether a seat paid for during the free trial will seat this person at this store when it ends (D176 §8) — so
   * inviting them into a full store prices no second seat. Reads only.
   */
  async coveredByScheduledSeat(userId: Buffer, branchId: Buffer): Promise<boolean> {
    const e = await evaluateActivation(this.prisma, userId);
    return e.coveredStores.some((b) => b.equals(branchId));
  }
}
