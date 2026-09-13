import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Who a store may START new business with, and how a connection request is
 * resolved.
 *
 * ## The rule (Partners milestone — supersedes the earlier manual allowance)
 *
 * A store may begin a NEW inter-store dealing — propose or accept a loan, propose
 * or accept a consignment, hand stock over — only while its connection with the
 * other store is **accepted**. Pending, rejected, cancelled, removed and blocked
 * relationships authorise nothing new.
 *
 * What stays open whatever the connection's state, so a relationship ending can
 * never trap a phone or a debt: reporting and confirming payments, confirming a
 * hand-over that was already sent, returning consigned stock, disputing,
 * rejecting or cancelling a proposal, forgiveness, and reading history.
 *
 * Acceptance authorises dealing, not any particular deal. Every consignment and
 * loan still needs its own agreement, custody confirmation and payment
 * confirmation from the other side.
 *
 * ## What it does not cover
 *
 * - `manual_person` and `employee` counterparties are not stores. Lending to a
 *   person or an employee is untouched.
 * - `manual_store` — a shop recorded by hand because it is not on the platform —
 *   can no longer start anything new: there is no one on the other side to accept
 *   a connection, which is exactly the gap the rule closes. Existing manual
 *   records remain readable and settleable.
 * - Retail sales, purchases from individuals and same-company branch transfers
 *   have their own authorisation models and never pass through here.
 */

export type CounterpartyKindLike = 'connected_store' | 'manual_store' | 'manual_person' | 'employee';
export type ConnectionStatusLike = 'pending' | 'accepted' | 'rejected' | 'blocked' | 'cancelled' | 'removed';

export interface DealingRefusal {
  code: 'connection_required' | 'connection_not_accepted' | 'connection_blocked';
  message: string;
}

/**
 * Pure: may a NEW dealing begin with this counterparty, given its connection?
 *
 * `null` means yes. Written as data-in, decision-out so every combination is
 * testable without a database — the combinations are the whole point.
 */
export function newDealingRefusal(input: {
  kind: CounterpartyKindLike;
  connectionStatus: ConnectionStatusLike | null;
}): DealingRefusal | null {
  if (input.kind === 'manual_person' || input.kind === 'employee') return null;

  if (input.kind === 'manual_store') {
    return {
      code: 'connection_required',
      message:
        'New dealings with another store need a connection that store has accepted. ' +
        'Records already made with this store can still be settled.',
    };
  }

  if (input.connectionStatus === 'accepted') return null;
  if (input.connectionStatus === 'blocked') {
    return { code: 'connection_blocked', message: 'That store is blocked. Existing dealings can still be settled.' };
  }
  return {
    code: 'connection_not_accepted',
    message:
      'You are not connected to that store. A new dealing needs a connection the other store has accepted; ' +
      'existing dealings can still be settled.',
  };
}

/**
 * Re-check the rule at COMMIT time, holding the connection row.
 *
 * Called inside the transaction that writes the dealing. `FOR UPDATE` is a
 * locking read, so it sees the latest committed status rather than the
 * transaction's snapshot, and it makes a concurrent removal wait. Either the
 * removal commits first and this refuses, or this commits first and the dealing
 * was made while the connection was genuinely accepted. A screen opened
 * yesterday, or a saved draft, authorises nothing on its own.
 */
export async function assertMayStartDealing(
  tx: Prisma.TransactionClient,
  counterpartyId: Buffer,
): Promise<void> {
  const cp = await tx.counterparty.findUnique({
    where: { id: counterpartyId },
    select: { kind: true, connectionId: true },
  });
  if (!cp) throw new NotFoundException('No such counterparty');

  let status: ConnectionStatusLike | null = null;
  if (cp.kind === 'connected_store' && cp.connectionId) {
    const rows = await tx.$queryRaw<{ status: ConnectionStatusLike }[]>(
      Prisma.sql`SELECT status FROM store_connections WHERE id = ${cp.connectionId} FOR UPDATE`,
    );
    status = rows[0]?.status ?? null;
  }

  const refusal = newDealingRefusal({ kind: cp.kind as CounterpartyKindLike, connectionStatus: status });
  if (refusal) throw new ConflictException({ code: refusal.code, message: refusal.message });
}

// --- connection requests ------------------------------------------------------

export type RequestOutcome =
  | { kind: 'create' }
  | { kind: 'reopen' }
  | { kind: 'already_requested' }
  | { kind: 'refuse'; status: 404 | 409; code: string; message: string };

/**
 * What asking to connect means, given the one relationship row a pair may have.
 *
 * - no row → create a pending request;
 * - my own pending request → a retry: nothing new is written;
 * - THEIR pending request to me → refused, never auto-accepted. Accepting on the
 *   other store's behalf, or treating two crossed requests as mutual consent,
 *   would connect a store that never pressed Accept;
 * - accepted → already connected;
 * - blocked → the same "no such store" as a store that does not exist, so a
 *   request cannot be used to learn who has blocked you;
 * - rejected, cancelled or removed → the row is reopened as a fresh pending
 *   request from me, which the other store must accept again. The pair key is
 *   unique, so the row is reused rather than duplicated.
 */
export function resolveConnectionRequest(
  existing: { status: ConnectionStatusLike; requesterIsMe: boolean } | null,
): RequestOutcome {
  if (!existing) return { kind: 'create' };
  switch (existing.status) {
    case 'blocked':
      return { kind: 'refuse', status: 404, code: 'store_not_found', message: 'No such store' };
    case 'accepted':
      return {
        kind: 'refuse',
        status: 409,
        code: 'connection_already_connected',
        message: 'You are already connected to that store',
      };
    case 'pending':
      return existing.requesterIsMe
        ? { kind: 'already_requested' }
        : {
            kind: 'refuse',
            status: 409,
            code: 'connection_incoming_pending',
            message: 'That store has already asked to connect with you. Accept or decline their request.',
          };
    case 'rejected':
    case 'cancelled':
    case 'removed':
      return { kind: 'reopen' };
  }
}

/** Only the store that asked may withdraw a request, and only while it is waiting. */
export function mayCancel(status: ConnectionStatusLike, requesterIsMe: boolean): boolean {
  return status === 'pending' && requesterIsMe;
}

/** Either store may end an accepted connection. */
export function mayRemove(status: ConnectionStatusLike): boolean {
  return status === 'accepted';
}
