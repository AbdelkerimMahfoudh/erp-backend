import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { BillingDb } from '../billing/billing.service';
import type { Activity } from '../entitlement/activity';
import { newUuidV7Bin } from '../common/utils/uuid.util';

/** What opening a store needs to know: whose it is, what it is called and does, and what the timeline says. */
export interface StoreOpening {
  companyId: Buffer;
  subscriptionId: Buffer;
  name: string;
  activity: Activity;
  actor: string;
  note: string;
}

/**
 * The Owners a new store is assigned to: every Owner of the business not deleted, once each, with the role they hold.
 * Read by {@link openStoreTx}, and by the trial's end before it opens a store, to take their rows first (N1).
 */
export async function storeOwners(tx: BillingDb, companyId: Buffer): Promise<{ userId: Buffer; roleId: Buffer }[]> {
  return tx.userBranch.findMany({
    where: {
      companyId,
      role: { key: 'owner' },
      user: { deletedAt: null },
    },
    distinct: ['userId'],
    select: { userId: true, roleId: true },
  });
}

/**
 * Open a store: the branch with its activity, every Owner assigned to it so the shop can use it at once, the
 * subscribed store count raised by one, and the timeline told why. One path for a store paid for, one that took an
 * archived store's place at no charge (D158), and one paid for during a free trial that opens when it ends (D176) —
 * so they can never open differently.
 *
 * Runs inside the caller's transaction, which holds the subscription row's lock.
 */
export async function openStoreTx(tx: BillingDb, input: StoreOpening): Promise<Buffer> {
  let branch: { id: Buffer };
  try {
    branch = await tx.branch.create({
      data: {
        id: newUuidV7Bin(),
        companyId: input.companyId,
        name: input.name,
        type: 'store',
        activity: input.activity,
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
  for (const o of await storeOwners(tx, input.companyId)) {
    await tx.userBranch.create({
      data: {
        id: newUuidV7Bin(),
        companyId: input.companyId,
        userId: o.userId,
        branchId: branch.id,
        roleId: o.roleId,
      },
    });
  }
  const counted = await tx.subscription.update({
    where: { id: input.subscriptionId },
    data: {
      subscribedBranchCount: { increment: 1 },
      version: { increment: 1 },
    },
    select: { subscribedBranchCount: true },
  });
  await tx.subscriptionEvent.create({
    data: {
      id: newUuidV7Bin(),
      companyId: input.companyId,
      subscriptionId: input.subscriptionId,
      kind: 'branches_changed',
      note: input.note.slice(0, 255),
      branchesAfter: counted.subscribedBranchCount,
      actor: input.actor.slice(0, 120),
    },
  });
  return branch.id;
}
