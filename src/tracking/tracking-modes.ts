import { BadRequestException, ConflictException } from '@nestjs/common';
import { TrackingType } from '@prisma/client';

/**
 * The one place the current product rule about intake modes lives.
 *
 * ## The rule
 *
 * A category's `defaultTrackingType` is the **stable, server-side** answer to
 * "how is this received?". Phone categories are `imei`; every other category in
 * the product today is `quantity`. Nothing anywhere decides this from a
 * category *name*: names are company-owned free text (`ProductCategory` is
 * `@@unique([companyId, name])`, not an enum), they are translated in the UI,
 * and "Téléphone", "هاتف" and "Phone" are all the same workflow. Reading intent
 * out of a label would make the workflow depend on the shop's spelling.
 *
 * ## Why `serial` is offered again
 *
 * It was withdrawn from the picker once, to stop a box of cables being
 * registered one at a time. That guard cost more than it saved: the shop sells
 * televisions, laptops and power stations that carry a serial and no IMEI, the
 * scanner classifies those serials correctly, and Receive already handles them
 * — but no new serial-tracked product could be created, so a scanned serial had
 * nowhere to go and the form proposed IMEI instead. Proposing IMEI for a
 * serial is the worse misconfiguration: it asks for a number the device does
 * not have.
 *
 * The protection that actually matters is elsewhere and is unchanged: a
 * category still DECIDES the mode (`resolveTrackingType` refuses a client that
 * contradicts it), so cables in an Accessories category cannot become
 * individually tracked whatever a form suggests. The mode is only the client's
 * to state for an uncategorised product.
 */
export const SELECTABLE_TRACKING_TYPES: readonly TrackingType[] = [
  TrackingType.imei,
  TrackingType.serial,
  TrackingType.quantity,
];

/** True when this product is received one physical item at a time. */
export function isSerialized(mode: TrackingType): boolean {
  return mode !== TrackingType.quantity;
}

/**
 * Guard a tracking mode the client picked.
 *
 * `previous` is what is already stored, when there is something stored. Passing
 * it is what lets historical `serial` data be saved again without becoming a
 * new selection — an edit that leaves the mode alone must never fail merely
 * because the value predates this rule.
 */
export function assertSelectableTrackingType(next: TrackingType, previous?: TrackingType | null): void {
  if (next === previous) return; // unchanged, including any historical mode
  if (!SELECTABLE_TRACKING_TYPES.includes(next)) {
    throw new BadRequestException(
      `Tracking mode '${next}' cannot be chosen. Devices are tracked one at a time by IMEI or serial number; everything else is counted by quantity.`,
    );
  }
}

/**
 * The client does not get a vote on the mode when a category is involved.
 *
 * A contradiction is refused rather than ignored. Silently overwriting the
 * client's value would leave a shop staring at a form that said one thing and a
 * product that does another; refusing says which one is authoritative. This is
 * the server-side half of "category drives the mode" — a manipulated client
 * cannot pick the Phone category and ask for `quantity` to skip the IMEI, nor
 * pick Accessories and ask for `imei`.
 */
export function resolveTrackingType(categoryMode: TrackingType, clientMode?: TrackingType | null): TrackingType {
  if (clientMode !== undefined && clientMode !== null && clientMode !== categoryMode) {
    throw new BadRequestException(
      `This category is tracked by '${categoryMode}', so '${clientMode}' cannot be used. The category decides how its products are received.`,
    );
  }
  return categoryMode;
}

/**
 * Refuse to reinterpret stock that already exists.
 *
 * Switching between "counted" and "individually identified" changes what every
 * existing row *means*, and there is no honest automatic answer: five `Unit`
 * rows are not a `StockItem` of five, because each carried its own cost and its
 * own IMEI. So the change is refused while history exists, and nothing is
 * migrated implicitly. Creating a new product is the correct move.
 */
export function assertTrackingChangeSafe(hasHistory: boolean, from: TrackingType, to: TrackingType): void {
  if (!hasHistory) return;
  throw new ConflictException({
    code: 'tracking_change_blocked',
    message:
      `This product already has stock or history, so it cannot change from '${from}' to '${to}'. ` +
      'Existing units, stock, transfers, purchases and sales would be reinterpreted. Create a new product instead.',
  });
}
