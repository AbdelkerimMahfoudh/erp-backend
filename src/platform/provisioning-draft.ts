import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * An administrator's account is a small state machine (D227, owner's release gate), not one database transaction: its
 * payment and activation run the billing lifecycle's own fenced transactions, period roll-over and audit, which are not
 * safe to nest. So registration writes a marked draft holding the whole request; each step below recognises work already
 * done; and only the last step makes it an ordinary account. A draft cannot be signed in to (no invitation and an unusable
 * password) and is shown as a draft everywhere, with a way to resume.
 */
export interface DraftBasis {
  kind: 'payment' | 'grant';
  reason: string;
  days?: number;
  amount?: string;
  paidAt?: string;
  reference?: string;
  channel?: 'manual' | 'bank_transfer' | 'mobile_money';
  months?: number;
  /** A controlled-test deferral to apply on completion, as the request asked. */
  deferral?: unknown;
}

export interface DraftLifecycle {
  activateByGrant(companyId: string, input: { days: number; reason: string }, ctx: DraftActor): Promise<unknown>;
  recordPayment(
    companyId: string,
    input: { amount: string; paidAt: Date; channel?: DraftBasis['channel']; reference?: string; note?: string; confirm?: boolean },
    ctx: DraftActor,
  ): Promise<unknown>;
  approve(companyId: string, input: { months?: number; reason?: string }, ctx: DraftActor): Promise<unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DraftActor = any;

export interface DraftOutcome {
  /** False: still a draft, and safe to resume. */
  complete: boolean;
  /** True for the one caller that finished it: only that caller may send the invitation. */
  completedNow: boolean;
  basis: DraftBasis | null;
}

export async function finishDraft(
  prisma: Pick<PrismaClient, 'company' | 'subscription'>,
  lifecycle: DraftLifecycle,
  companyId: Buffer,
  companyUuid: string,
  ctx: DraftActor,
): Promise<DraftOutcome> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { provisioningState: true, provisioningBasis: true },
  });
  if (company?.provisioningState !== 'draft') return { complete: true, completedNow: false, basis: null };
  const basis = company.provisioningBasis as unknown as DraftBasis;

  try {
    if (basis.kind === 'grant') {
      // A grant counts its days from now, so a resume must not lengthen one that already went through. Its trail, period
      // and audit committed with it (`activateByGrant`), so there is nothing left to repair when this finds it done.
      const sub = await prisma.subscription.findFirst({ where: { companyId }, select: { status: true, isComplimentary: true } });
      if (!(sub?.status === 'activated' && sub.isComplimentary)) {
        await lifecycle.activateByGrant(companyUuid, { days: basis.days!, reason: basis.reason }, ctx);
      }
    } else {
      // Recognised by its reference, channel, amount and date; approval by the state it left.
      await lifecycle.recordPayment(
        companyUuid,
        { amount: basis.amount!, paidAt: new Date(basis.paidAt!), channel: basis.channel, reference: basis.reference, note: basis.reason, confirm: true },
        ctx,
      );
      await lifecycle.approve(companyUuid, { months: basis.months, reason: basis.reason }, ctx);
    }
  } catch {
    return { complete: false, completedNow: false, basis };
  }

  const moved = await prisma.company.updateMany({
    where: { id: companyId, provisioningState: 'draft' },
    data: { provisioningState: null, provisioningBasis: Prisma.DbNull },
  });
  return { complete: true, completedNow: moved.count === 1, basis };
}
