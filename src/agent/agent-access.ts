import { ForbiddenException } from '@nestjs/common';
import type { TenantPrisma } from '../prisma/tenant.extension';
import { branchAccessDenied } from '../rbac/refusals';

/**
 * Who, and which branch, may use the agent counter (D156, docs/73 §7).
 *
 * A branch records exchanges only while its activity is `money_agent` or
 * `both`; an electronics-only branch is refused by name, with the activity it
 * has and the one it would need — a flag the website turns into a request,
 * never a price inside the app. The gate reads `branches.activity` itself (one
 * indexed read) so the ledger is safe on its own, whatever runs in front of it.
 */

export type BranchActivity = 'electronics' | 'money_agent' | 'both';

/** The nine keys of the activity (docs/73 §7). Any one of them opens the provider list. */
export const AGENT_PERMISSIONS = [
  'agent.transaction.record',
  'agent.transaction.view',
  'agent.customer.reveal',
  'agent.mistake.report',
  'agent.transaction.reverse',
  'agent.rebalance',
  'agent.position.set',
  'agent.report.view',
  'agent.provider.manage',
] as const;

export function agentActivityAllowed(activity: BranchActivity): boolean {
  return activity === 'money_agent' || activity === 'both';
}

/** The refusal: 403, the branch's activity and the one it needs. */
export function activityNotSubscribed(activity: BranchActivity): ForbiddenException {
  return new ForbiddenException({
    code: 'activity_not_subscribed',
    activity,
    required: 'money_agent',
    message: 'This branch is not subscribed to the money services activity, so the agent counter is not available here.',
  });
}

type BranchReader = Pick<TenantPrisma, 'branch'>;

/** The branch's activity, as stored. A branch outside the company reads as no access, like the guard says it. */
export async function branchActivityOf(db: BranchReader, branchId: Buffer): Promise<BranchActivity> {
  const branch = await db.branch.findFirst({ where: { id: branchId }, select: { activity: true } });
  if (!branch) throw branchAccessDenied();
  return branch.activity;
}

/** The branch's activity, or the refusal. */
export async function requireAgentActivity(db: BranchReader, branchId: Buffer): Promise<BranchActivity> {
  const activity = await branchActivityOf(db, branchId);
  if (!agentActivityAllowed(activity)) throw activityNotSubscribed(activity);
  return activity;
}

export function hasAnyAgentPermission(held: ReadonlySet<string> | undefined): boolean {
  return AGENT_PERMISSIONS.some((key) => held?.has(key) ?? false);
}
