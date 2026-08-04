import { ConflictException } from '@nestjs/common';
import { UnitStatus } from '@prisma/client';

/**
 * The legal unit lifecycle (see docs/16 §Workflow 5). Pure + unit-tested; the DB
 * sold-once unique index is the final backstop.
 *
 * EXTENSIBILITY: this is a data-driven map, so new states are added with one
 * entry (plus references from/to them). Planned future states:
 *   - `reserved` — already in the enum; hold-for-customer flow (Sprint later).
 *   - `scrapped` — NOT yet in the enum: adding it needs an enum migration +
 *     an entry here (e.g. `faulty: [..., 'scrapped']`, `scrapped: []`). No
 *     structural rework of the machine is required.
 * Terminal states (no outgoing transitions): `transferred_out` (and future
 * `scrapped`).
 */
const TRANSITIONS: Record<UnitStatus, UnitStatus[]> = {
  in_stock: ['reserved', 'sold', 'in_transit', 'faulty', 'transferred_out'],
  reserved: ['sold', 'in_stock'], // future: hold-for-customer
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
