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
  in_stock: ['reserved', 'sold', 'in_transit', 'faulty', 'transferred_out'],
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
  sold: ['returned'],
  returned: ['in_stock', 'faulty'],
  in_transit: ['in_stock', 'transferred_out'],
  faulty: ['in_stock'], // future: add 'scrapped'
  transferred_out: [],
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
