import { ConflictException } from '@nestjs/common';
import { UnitStatus } from '@prisma/client';

/**
 * The legal unit lifecycle (see docs/16 §Workflow 5). Pure + unit-tested; the DB
 * sold-once unique index is the final backstop.
 *
 * EXTENSIBILITY: this is a data-driven map, so new states are added with one
 * entry (plus references from/to them). Planned future state:
 *   - `scrapped` — NOT yet in the enum: adding it needs an enum migration +
 *     an entry here (e.g. `faulty: [..., 'scrapped']`, `scrapped: []`). No
 *     structural rework of the machine is required.
 * Terminal states (no outgoing transitions): `transferred_out` (and future
 * `scrapped`).
 *
 * `reserved` is live as of H1.1: a unit promised to an open transfer. It is
 * reached at transfer **request** and released on cancellation before shipment.
 */
const TRANSITIONS: Record<UnitStatus, UnitStatus[]> = {
  /**
   * `voided` only by an approved purchase cancellation (0079): the phone never
   * entered the books.
   */
  in_stock: ['reserved', 'sold', 'in_transit', 'faulty', 'transferred_out', 'consigned_out', 'voided'],
  /**
   * **A reserved unit cannot be sold.** It used to list `sold` here, which
   * contradicted `SalesPolicyService.assertSellable` — that requires `in_stock`
   * and has always refused reserved stock. Two rules disagreeing about whether
   * a promised phone may be sold is exactly the kind of gap that eventually
   * gets resolved in the wrong direction, so the machine now matches Sell.
   *
   * Release the reservation first (`reserved → in_stock`) and the unit becomes
   * sellable again. `in_transit` is the shipment step of its own transfer.
   */
  reserved: ['in_stock', 'in_transit'],
  /**
   * `in_stock` only by an approved cancellation of the sale (0079): the sale should
   * not have been recorded, so the phone was never really sold. A customer bringing
   * a phone back is a return, never this.
   */
  sold: ['returned', 'in_stock'],
  returned: ['in_stock', 'faulty'],
  in_transit: ['in_stock', 'transferred_out'],
  faulty: ['in_stock'], // future: add 'scrapped'
  transferred_out: [],
  /**
   * Held by another COMPANY on consignment (0049). **Not terminal**, and that
   * is the whole difference from `transferred_out`: the phone is still ours.
   *
   *   → `in_stock` when it comes back unsold and we confirm receipt;
   *   → `sold`     when the holding store sells it and reports the disposition;
   *   → `faulty`   when it comes back damaged, which routes it to inspection
   *                rather than straight back onto the shelf.
   *
   * There is deliberately no `consigned_out → reserved` or `→ in_transit`: a
   * phone in somebody else's shop cannot be promised to one of our transfers,
   * and pretending otherwise would let two shops believe they hold it.
   */
  consigned_out: ['in_stock', 'sold', 'faulty'],
  /**
   * A phone whose purchase was cancelled (0079) comes back only when the same IMEI
   * is received again: the record is reactivated, so one IMEI stays one record.
   */
  voided: ['in_stock'],
};

export function canTransition(from: UnitStatus, to: UnitStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Throws 409 with a plain-language reason if the transition is illegal. */
export function assertTransition(from: UnitStatus, to: UnitStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictException(`A unit that is '${from}' cannot become '${to}'`);
  }
}
