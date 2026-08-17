import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * **The only safe way to read a consignment** (Milestone H).
 *
 * `consignments` is the first table in this schema that legitimately belongs to
 * two companies at once, so `tenant.extension.ts` cannot scope it — the guard
 * that protects every other table stops protecting this one.
 *
 * Every read in the consignment module goes through the filters here. That is
 * not a convention anybody has to remember: `consignment-scope.spec.ts` reads
 * the service source and fails if a `consignment*` query appears without one.
 *
 * The rule is simple and must stay simple, because a complicated access rule is
 * one nobody can verify by reading it:
 *
 *   You may see a consignment if you are the source OR the destination.
 *   Nothing else. No branch nuance, no role nuance, no exceptions.
 */

/** Which side of a consignment a company is on. */
export type Side = 'source' | 'destination';

/**
 * The where-clause fragment that scopes a consignment to one company.
 *
 * A manual counterparty has no `destinationCompanyId`, so only the source
 * matches — which is correct: there is no second tenant to show it to.
 */
export function visibleToCompany(companyId: Buffer): Prisma.ConsignmentWhereInput {
  return {
    OR: [{ sourceCompanyId: companyId }, { destinationCompanyId: companyId }],
  };
}

/** The same, for ledger rows, which carry both company columns of their own. */
export function ledgerVisibleToCompany(
  companyId: Buffer,
): Prisma.ConsignmentLedgerEntryWhereInput {
  return {
    OR: [{ sourceCompanyId: companyId }, { destinationCompanyId: companyId }],
  };
}

/** Lines are scoped through their parent, never independently. */
export function lineVisibleToCompany(companyId: Buffer): Prisma.ConsignmentLineWhereInput {
  return { consignment: visibleToCompany(companyId) };
}

export interface SidedConsignment {
  sourceCompanyId: Buffer;
  destinationCompanyId: Buffer | null;
}

/**
 * Which side this company is on, refusing anything else.
 *
 * Throws `NotFoundException`, never `ForbiddenException`, when a company is on
 * neither side. A 403 would confirm the consignment exists, which is an oracle:
 * somebody could enumerate ids and learn who is trading with whom. A 404 is the
 * same answer they would get for an id that never existed.
 */
export function sideOf(consignment: SidedConsignment, companyId: Buffer): Side {
  if (consignment.sourceCompanyId.equals(companyId)) return 'source';
  if (consignment.destinationCompanyId?.equals(companyId)) return 'destination';
  throw new NotFoundException('No such consignment');
}

/** Assert this company is the source, for acts only an owner of stock may do. */
export function assertSource(consignment: SidedConsignment, companyId: Buffer): void {
  if (sideOf(consignment, companyId) !== 'source') {
    throw new ForbiddenException('Only the sending store can do that');
  }
}

/** Assert this company is the destination, for acts only the holder may do. */
export function assertDestination(consignment: SidedConsignment, companyId: Buffer): void {
  if (sideOf(consignment, companyId) !== 'destination') {
    throw new ForbiddenException('Only the receiving store can do that');
  }
}

/**
 * What each side is allowed to see of the money and the goods.
 *
 * The privacy rules, in one place rather than scattered across shaping code:
 *
 * - **Store 1 never learns the resale price, the customer, or Store 2's
 *   margin.** All it is entitled to know is that the phone was sold and the
 *   agreed amount is now owed.
 * - **Store 2 never learns Store 1's cost, supplier, purchase or margin.** The
 *   agreed amount is its cost basis and the only figure it needs.
 *
 * Neither of these is enforced by hiding a column in a response shaper alone —
 * the underlying tables simply do not carry the other side's figures. This
 * function exists so the intent is written down where somebody adding a field
 * will read it.
 */
export const CONSIGNMENT_PRIVACY = {
  /** Fields a destination company may never receive about a line. */
  hiddenFromDestination: ['cost', 'purchaseCost', 'supplierId', 'purchaseId', 'margin'] as const,
  /** Fields a source company may never receive about a resale. */
  hiddenFromSource: ['salePrice', 'saleId', 'customerId', 'customerName', 'margin'] as const,
} as const;
