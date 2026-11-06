import { Inject, Injectable, Logger, Optional, forwardRef } from '@nestjs/common';
import { EntitlementService } from './entitlement.service';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { CLOCK, type Clock } from './clock';
import { GRACE_MS } from './grace-rules';
import {
  BRANCH_GRACE_ALLOWANCE,
  addMonths,
  branchCanRead,
  branchCanWrite,
  branchState,
  paidPeriodStart,
  type BranchFacts,
  type BranchGrace,
  type BranchState,
} from './branch-rules';

type Db = PrismaService | Prisma.TransactionClient;

/** `off`: the business-wide gate only. `shadow`: branch decisions computed and logged, nothing blocked. `enforce`. */
export type BranchEntitlementMode = 'off' | 'shadow' | 'enforce';

export interface BranchStatus {
  branchId: string;
  name: string;
  /** D225: the Arabic name, shown by the Arabic interface; null until given. */
  nameAr: string | null;
  state: BranchState;
  canWrite: boolean;
  trialEndsAt: string | null;
  paidUntil: string | null;
  complimentaryUntil: string | null;
  graceEndsAt: string | null;
}

export const BRANCH_WRITE_BLOCKED = 'BRANCH_ENTITLEMENT_WRITE_BLOCKED';
export const BRANCH_LOCKED = 'BRANCH_LOCKED';

const MESSAGE: Record<Exclude<BranchState, 'active' | 'grace' | 'complimentary' | 'trial_active'>, string> = {
  suspended: 'This business is suspended, so nothing can be changed.',
  locked: 'This branch is not active yet. It opens when its payment is approved.',
  trial_expired: 'This branch’s free trial has ended. You can still read and export everything.',
  expired: 'This branch’s subscription has ended. You can still read and export everything.',
};

/**
 * Per-branch entitlements (0132; docs/122): each store branch's state, read on every branch-scoped request — never
 * cached, so an end stops writes at its exact instant — and the writes that open or extend a branch.
 */
@Injectable()
export class BranchEntitlementService {
  private readonly log = new Logger(BranchEntitlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    /** The business-wide state, followed by a store with no row of its own; absent where a test builds this by hand. */
    @Optional() @Inject(forwardRef(() => EntitlementService)) private readonly business?: EntitlementService,
  ) {}

  /** What a store without its own row follows: the business's state, mapped; null when it gives the store nothing. */
  private async inherited(companyId: Buffer, branchId: Buffer, db: Db): Promise<BranchState | null> {
    const s = await this.business!.businessState(companyId);
    switch (s) {
      case 'active':
      case 'grace':
      case 'complimentary':
      case 'expired':
      case 'trial_expired':
        return s;
      case 'cancelled':
        return 'expired';
      case 'suspended':
      case 'rejected':
        return 'suspended';
      case 'trial_active': {
        const first = await db.branch.findFirst({
          where: { companyId, type: 'store', deletedAt: null },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true },
        });
        return first?.id.equals(branchId) ? 'trial_active' : 'locked';
      }
      default:
        return 'locked';
    }
  }

  get mode(): BranchEntitlementMode {
    const v = (process.env.BRANCH_ENTITLEMENTS ?? 'enforce').trim().toLowerCase();
    return v === 'off' || v === 'shadow' ? v : 'enforce';
  }

  /** One branch's state, or null when the branch is not a store of this business. */
  async stateOf(companyId: Buffer, branchId: Buffer, db: Db = this.prisma): Promise<{ state: BranchState; facts: BranchFacts | null; graceEndsAt: Date | null } | null> {
    const branch = await db.branch.findFirst({
      where: { id: branchId, companyId },
      select: { type: true, deletedAt: true, isActive: true, entitlement: true },
    });
    if (!branch) return null;
    const stopped = await this.accountStopped(companyId, db);
    // Not a store (a warehouse): it follows the business — writable while any store can write.
    if (branch.type !== 'store') {
      const any = await this.anyWritable(companyId, db);
      return { state: stopped ? 'suspended' : any ? 'active' : 'expired', facts: null, graceEndsAt: null };
    }
    const facts = branch.entitlement ? factsOf(branch.entitlement) : null;
    const now = this.clock.now();
    // A store with no row of its own follows the business, as every store did before 0132 — a store opened outside
    // the per-branch flows is never locked by the change. The trial alone is never inherited: it is the first store's.
    if (!facts && this.business) {
      if (stopped) return { state: 'suspended', facts: null, graceEndsAt: null };
      const inherited = await this.inherited(companyId, branchId, db);
      if (inherited) return { state: inherited, facts: null, graceEndsAt: null };
    }
    const { grace, usesBefore } = await this.graceFor(companyId, branchId, facts, db);
    const state = branchState({ facts, accountStopped: stopped, grace, graceUsesBefore: usesBefore }, now);
    if (state === 'grace' && !grace && facts?.paidUntil) await this.recordGrace(companyId, branchId, facts.paidUntil, 'granted', usesBefore, now, db);
    if (state === 'expired' && !grace && facts?.paidUntil && now.getTime() < facts.paidUntil.getTime() + GRACE_MS) {
      await this.recordGrace(companyId, branchId, facts.paidUntil, 'refused', usesBefore, now, db);
    }
    const graceEndsAt = state === 'grace' && facts?.paidUntil ? new Date(facts.paidUntil.getTime() + GRACE_MS) : null;
    return { state, facts, graceEndsAt };
  }

  /** Why a write to this branch is refused, or null. A branch of another business reads as locked. */
  async writeRefusal(companyId: Buffer, branchId: Buffer): Promise<{ code: string; message: string; state: BranchState; branchId: string } | null> {
    const s = await this.stateOf(companyId, branchId);
    const state = s?.state ?? 'locked';
    if (branchCanWrite(state)) return null;
    return { code: state === 'locked' ? BRANCH_LOCKED : BRANCH_WRITE_BLOCKED, message: MESSAGE[state as keyof typeof MESSAGE], state, branchId: binToUuid(branchId) };
  }

  async readRefusal(companyId: Buffer, branchId: Buffer): Promise<{ code: string; message: string; state: BranchState; branchId: string } | null> {
    const s = await this.stateOf(companyId, branchId);
    const state = s?.state ?? 'locked';
    if (branchCanRead(state)) return null;
    return { code: state === 'locked' ? BRANCH_LOCKED : BRANCH_WRITE_BLOCKED, message: MESSAGE[state as keyof typeof MESSAGE], state, branchId: binToUuid(branchId) };
  }

  /** Every store of the business with its state — the app's and the console's status, and the portal's quote. */
  async listForCompany(companyId: Buffer, db: Db = this.prisma): Promise<BranchStatus[]> {
    const stores = await db.branch.findMany({
      where: { companyId, type: 'store', deletedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, nameAr: true },
    });
    const out: BranchStatus[] = [];
    for (const b of stores) {
      const s = await this.stateOf(companyId, b.id, db);
      if (!s) continue;
      out.push({
        branchId: binToUuid(b.id),
        name: b.name,
        nameAr: b.nameAr,
        state: s.state,
        canWrite: branchCanWrite(s.state),
        trialEndsAt: s.facts?.trialEndsAt?.toISOString() ?? null,
        paidUntil: s.facts?.paidUntil?.toISOString() ?? null,
        complimentaryUntil: s.facts?.complimentaryUntil?.toISOString() ?? null,
        graceEndsAt: s.graceEndsAt?.toISOString() ?? null,
      });
    }
    return out;
  }

  /** Whether at least one store of the business can write: the gate for business-wide changes. */
  async anyWritable(companyId: Buffer, db: Db = this.prisma): Promise<boolean> {
    if (await this.accountStopped(companyId, db)) return false;
    const stores = await db.branch.findMany({ where: { companyId, type: 'store', deletedAt: null }, select: { id: true } });
    for (const b of stores) {
      const s = await this.stateOf(companyId, b.id, db);
      if (s && branchCanWrite(s.state)) return true;
    }
    return false;
  }


  /**
   * A paid period for one branch, inside the approval's transaction (docs/122 §5). Idempotent: a period already
   * recorded for this proof (or payment) and branch is returned as it is, and nothing moves.
   */
  async applyPaidTx(
    tx: Prisma.TransactionClient,
    input: { companyId: Buffer; branchId: Buffer; months: number; amount: number | null; paymentId: Buffer | null; proofId: Buffer | null; actor: string; now: Date },
  ): Promise<{ applied: boolean; startsAt: Date; endsAt: Date }> {
    const { companyId, branchId, now } = input;
    const prior = input.proofId
      ? await tx.branchPeriod.findFirst({ where: { paymentProofId: input.proofId, branchId } })
      : input.paymentId
        ? await tx.branchPeriod.findFirst({ where: { paymentId: input.paymentId, branchId } })
        : null;
    if (prior) return { applied: false, startsAt: prior.startsAt, endsAt: prior.endsAt! };
    await tx.$queryRaw(Prisma.sql`SELECT id FROM branch_entitlements WHERE branch_id = ${branchId} FOR UPDATE`);
    const s = await this.stateOf(companyId, branchId, tx);
    const startsAt = paidPeriodStart(s?.facts ?? null, s?.state ?? 'locked', now);
    const endsAt = addMonths(startsAt, input.months);
    await tx.branchEntitlement.upsert({
      where: { branchId },
      create: { id: newUuidV7Bin(), companyId, branchId, paidUntil: endsAt },
      update: { paidUntil: endsAt, version: { increment: 1 } },
    });
    await tx.branchPeriod.create({
      data: {
        id: newUuidV7Bin(),
        companyId,
        branchId,
        source: 'payment',
        months: input.months,
        startsAt,
        endsAt,
        amount: input.amount,
        paymentId: input.paymentId,
        paymentProofId: input.proofId,
        recordedBy: input.actor,
      },
    });
    await this.syncCompanyEnd(tx, companyId);
    return { applied: true, startsAt, endsAt };
  }

  /** The free trial, on the business's first store only (docs/122 §1). Never on an additional branch. */
  startTrialTx(tx: Prisma.TransactionClient, input: { companyId: Buffer; startedAt: Date; endsAt: Date; actor: string }): Promise<Buffer | null> {
    return startBranchTrialTx(tx, input);
  }

  /**
   * A store opened by the Super Admin in the console (not an app request): it takes the business's timeline, as every
   * store did before 0132 — never a trial. A business with nothing paid or granted gives it nothing: it stays locked.
   */
  inheritTx(tx: Prisma.TransactionClient, input: { companyId: Buffer; branchId: Buffer; actor: string; now: Date }): Promise<void> {
    return inheritCompanyTimelineTx(tx, input);
  }


  /**
   * A business-wide decision of the Super Admin (approve, extend, grant) applied to its stores: the console still
   * decides for the whole business, and each store that has a timeline (or is the only one) follows it.
   */
  followCompanyTx(tx: Prisma.TransactionClient, input: { companyId: Buffer; actor: string; now: Date }): Promise<void> {
    return followCompanyTimelineTx(tx, input);
  }


  /** `subscriptions.current_period_end`: the latest paid end among the business's stores — for readers needing a date. */
  async syncCompanyEnd(tx: Prisma.TransactionClient, companyId: Buffer): Promise<void> {
    const latest = await tx.branchEntitlement.aggregate({ where: { companyId }, _max: { paidUntil: true } });
    const end = latest._max.paidUntil;
    if (!end) return;
    await tx.subscription.updateMany({
      where: { companyId, OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { lt: end } }] },
      data: { currentPeriodEnd: end, version: { increment: 1 } },
    });
  }

  /** Logged in shadow mode: where the branch decision would differ from the business-wide one. */
  shadow(companyId: Buffer, branchId: Buffer | null, businessAllows: boolean, branchAllows: boolean, route: string): void {
    if (businessAllows === branchAllows) return;
    this.log.warn(
      `branch-entitlement shadow: company ${binToUuid(companyId)} branch ${branchId ? binToUuid(branchId) : '-'} ${route}: business ${businessAllows ? 'allows' : 'refuses'}, branch ${branchAllows ? 'allows' : 'refuses'}`,
    );
  }

  private async accountStopped(companyId: Buffer, db: Db): Promise<boolean> {
    const c = await db.company.findUnique({
      where: { id: companyId },
      select: { isActive: true, closedAt: true, deletedAt: true, subscription: { select: { status: true } } },
    });
    if (!c || !c.isActive || c.closedAt || c.deletedAt) return true;
    const status = c.subscription?.status;
    return status === 'suspended' || status === 'rejected';
  }

  private async graceFor(companyId: Buffer, branchId: Buffer, facts: BranchFacts | null, db: Db): Promise<{ grace: BranchGrace | null; usesBefore: number }> {
    if (!facts?.paidUntil) return { grace: null, usesBefore: 0 };
    const end = facts.paidUntil;
    const recorded = await db.branchGraceEpisode.findUnique({ where: { branchId_periodEnd: { branchId, periodEnd: end } } });
    if (recorded) return { grace: { periodEnd: recorded.periodEnd, decision: recorded.decision, endsAt: recorded.endsAt }, usesBefore: recorded.usesBefore };
    const windowStart = addMonths(end, -12);
    const usesBefore = await db.branchGraceEpisode.count({ where: { companyId, branchId, decision: 'granted', startedAt: { gt: windowStart } } });
    return { grace: null, usesBefore };
  }

  private async recordGrace(companyId: Buffer, branchId: Buffer, periodEnd: Date, decision: 'granted' | 'refused', usesBefore: number, now: Date, db: Db): Promise<void> {
    try {
      await db.branchGraceEpisode.create({
        data: {
          id: newUuidV7Bin(),
          companyId,
          branchId,
          periodEnd,
          decision: usesBefore >= BRANCH_GRACE_ALLOWANCE ? 'refused' : decision,
          startedAt: periodEnd,
          endsAt: new Date(periodEnd.getTime() + GRACE_MS),
          usesBefore: Math.min(usesBefore, 255),
          recordedAt: now,
        },
      });
    } catch (e) {
      // Recorded meanwhile by another request: the first decision stands.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    }
  }
}

function factsOf(r: { trialEndsAt: Date | null; paidUntil: Date | null; complimentary: boolean; complimentaryUntil: Date | null }): BranchFacts {
  return { trialEndsAt: r.trialEndsAt, paidUntil: r.paidUntil, complimentary: r.complimentary, complimentaryUntil: r.complimentaryUntil };
}

function later(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

function eq(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

/** The free trial on the business's first store (0132): its trial end and its history entry. Used by every trial start. */
export async function startBranchTrialTx(
  tx: Prisma.TransactionClient,
  input: { companyId: Buffer; startedAt: Date; endsAt: Date; actor: string },
): Promise<Buffer | null> {
  const first = await tx.branch.findFirst({
    where: { companyId: input.companyId, type: 'store', deletedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  if (!first) return null;
  await tx.branchEntitlement.upsert({
    where: { branchId: first.id },
    create: { id: newUuidV7Bin(), companyId: input.companyId, branchId: first.id, trialEndsAt: input.endsAt },
    update: { trialEndsAt: input.endsAt, version: { increment: 1 } },
  });
  await tx.branchPeriod.create({
    data: { id: newUuidV7Bin(), companyId: input.companyId, branchId: first.id, source: 'trial', startsAt: input.startedAt, endsAt: input.endsAt, recordedBy: input.actor },
  });
  return first.id;
}

export async function inheritCompanyTimelineTx(tx: Prisma.TransactionClient, input: { companyId: Buffer; branchId: Buffer; actor: string; now: Date }): Promise<void> {
  const sub = await tx.subscription.findFirst({
    where: { companyId: input.companyId },
    select: { currentPeriodEnd: true, isComplimentary: true, complimentaryUntil: true },
  });
  const paidUntil = sub?.currentPeriodEnd && sub.currentPeriodEnd.getTime() > input.now.getTime() ? sub.currentPeriodEnd : null;
  const complimentary = !!sub?.isComplimentary && (!sub.complimentaryUntil || sub.complimentaryUntil.getTime() > input.now.getTime());
  if (!paidUntil && !complimentary) return;
  await tx.branchEntitlement.upsert({
    where: { branchId: input.branchId },
    create: { id: newUuidV7Bin(), companyId: input.companyId, branchId: input.branchId, paidUntil, complimentary, complimentaryUntil: complimentary ? sub!.complimentaryUntil : null },
    update: {},
  });
  await tx.branchPeriod.create({
    data: {
      id: newUuidV7Bin(),
      companyId: input.companyId,
      branchId: input.branchId,
      source: complimentary ? 'grant' : 'admin',
      startsAt: input.now,
      endsAt: complimentary ? sub!.complimentaryUntil : paidUntil,
      recordedBy: input.actor,
      note: 'Opened by the Super Admin: the business’s timeline.',
    },
  });
}

export async function followCompanyTimelineTx(tx: Prisma.TransactionClient, input: { companyId: Buffer; actor: string; now: Date }): Promise<void> {
  const sub = await tx.subscription.findFirst({
    where: { companyId: input.companyId },
    select: { currentPeriodEnd: true, isComplimentary: true, complimentaryUntil: true },
  });
  if (!sub) return;
  const stores = await tx.branch.findMany({ where: { companyId: input.companyId, type: 'store', deletedAt: null }, select: { id: true, entitlement: true } });
  for (const b of stores) {
    const e = b.entitlement;
    const paidUntil = later(e?.paidUntil ?? null, sub.currentPeriodEnd);
    const complimentary = sub.isComplimentary;
    const complimentaryUntil = sub.isComplimentary ? sub.complimentaryUntil : null;
    if (!paidUntil && !complimentary) continue;
    const same = e && eq(e.paidUntil, paidUntil) && e.complimentary === complimentary && eq(e.complimentaryUntil, complimentaryUntil);
    if (same) continue;
    await tx.branchEntitlement.upsert({
      where: { branchId: b.id },
      create: { id: newUuidV7Bin(), companyId: input.companyId, branchId: b.id, paidUntil, complimentary, complimentaryUntil },
      update: { paidUntil, complimentary, complimentaryUntil, version: { increment: 1 } },
    });
    await tx.branchPeriod.create({
      data: {
        id: newUuidV7Bin(),
        companyId: input.companyId,
        branchId: b.id,
        source: complimentary ? 'grant' : 'admin',
        startsAt: input.now,
        endsAt: complimentary ? complimentaryUntil : paidUntil,
        recordedBy: input.actor,
        note: 'The Super Admin’s decision for the business.',
      },
    });
  }
}
