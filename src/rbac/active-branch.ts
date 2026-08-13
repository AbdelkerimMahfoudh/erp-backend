import { ForbiddenException } from '@nestjs/common';

/**
 * Confirm the caller is actually assigned to the branch they are asking about.
 *
 * ## Why a read needs this at all
 *
 * `PermissionsGuard` validates branch assignment as a side effect of resolving
 * permissions — but it **exits early on a route that requires none**. The
 * active branch itself comes from the `X-Branch-Id` header via CLS middleware,
 * which sets it without judging it (deliberately: branch is request context,
 * not an authorization result).
 *
 * So an unguarded read is scoped to whatever branch the caller *claims*. G2A-CP3
 * found this on the pricing reads; H1.4.1 found the same thing on
 * `GET /inventory`, where any signed-in user could list another branch's stock —
 * and with it that branch's average cost — simply by changing a header.
 *
 * Anything that returns branch-scoped data from a route without
 * `@RequirePermissions` must call this. It is cheap: one indexed lookup on
 * `(user_id, branch_id)`.
 */

export interface AssignmentReadable {
  userBranch: { findFirst(args: unknown): Promise<{ id: Buffer } | null> };
}

export async function assertAssignedToBranch(
  db: AssignmentReadable,
  userId: Buffer,
  branchId: Buffer,
): Promise<Buffer> {
  const assignment = await db.userBranch.findFirst({
    where: { userId, branchId },
    select: { id: true },
  });
  // Same wording as the guard, so a caller cannot tell from the message
  // whether the branch exists, only that it is not theirs.
  if (!assignment) throw new ForbiddenException('No access to the requested branch');
  return branchId;
}
