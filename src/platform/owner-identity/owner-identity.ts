import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { newUuidV7Bin } from '../../common/utils/uuid.util';

/** The contacts one Owner claims across the platform (D227). */
export interface OwnerContacts {
  phone?: string | null;
  email?: string | null;
}

type Lookup = Pick<Prisma.TransactionClient, 'ownerIdentity'>;

/** Thrown inside a registration transaction when another Owner won the contact: the caller decides what to say. */
export class OwnerIdentityTakenError extends Error {
  constructor(readonly kind: 'phone' | 'email') {
    super('owner_identity_taken');
  }
}

const canonical = (kind: 'phone' | 'email', value: string): string => (kind === 'email' ? value.trim().toLowerCase() : value);

/** Who already holds this contact as an Owner. Never returned to an unauthenticated caller. */
export async function claimedBy(db: Lookup, kind: 'phone' | 'email', value: string): Promise<{ companyId: Buffer; userId: Buffer } | null> {
  return db.ownerIdentity.findUnique({
    where: { kind_value: { kind, value: canonical(kind, value) } },
    select: { companyId: true, userId: true },
  });
}

/**
 * Claim a new business's Owner contacts, in the transaction that creates it. The unique index decides a race: of two
 * registrations at once, one commits and the other gets {@link OwnerIdentityTakenError} and rolls back whole.
 */
export async function claimOwnerContactsTx(tx: Prisma.TransactionClient, companyId: Buffer, userId: Buffer, contacts: OwnerContacts): Promise<void> {
  for (const kind of ['phone', 'email'] as const) {
    const value = contacts[kind];
    if (!value) continue;
    try {
      await tx.ownerIdentity.create({ data: { id: newUuidV7Bin(), kind, value: canonical(kind, value), companyId, userId } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new OwnerIdentityTakenError(kind);
      throw e;
    }
  }
}

/**
 * An Owner's contact changed: move their claim. Nothing happens for anyone who is not an Owner of a non-test business,
 * so staff keep sharing a number across businesses. The refusal names nobody: it must not say who holds the contact.
 */
export async function moveOwnerContactTx(
  tx: Prisma.TransactionClient,
  user: { id: Buffer; companyId: Buffer },
  kind: 'phone' | 'email',
  next: string | null,
): Promise<void> {
  const isOwner = await tx.userBranch.findFirst({ where: { userId: user.id, role: { key: 'owner' } }, select: { id: true } });
  if (!isOwner) return;
  const company = await tx.company.findUnique({ where: { id: user.companyId }, select: { isTest: true } });
  if (company?.isTest) return;
  await tx.ownerIdentity.deleteMany({ where: { userId: user.id, kind } });
  if (!next) return;
  try {
    await tx.ownerIdentity.create({ data: { id: newUuidV7Bin(), kind, value: canonical(kind, next), companyId: user.companyId, userId: user.id } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new ConflictException({ code: 'contact_unavailable', message: 'That contact cannot be used for this account.' });
    }
    throw e;
  }
}
