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
 * ## Why `serial` is not offered
 *
 * The tracking engine supports three modes and the strategy registry still
 * implements all three. But `serial` is deliberately **not selectable** right
 * now: the approved decision is that only `Phone` is individually tracked, and
 * offering a third mode in the picker would invite exactly the misconfiguration
 * this module exists to prevent — a box of cables registered one at a time.
 *
 * It is not *removed*, because removing it would strand data. A category or
 * product already stored as `serial` keeps working, keeps its units, and may be
 * saved again unchanged. What is refused is *newly choosing* it.
 */
export const SELECTABLE_TRACKING_TYPES: readonly TrackingType[] = [TrackingType.imei, TrackingType.quantity];

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
  if (next === previous) return; // unchanged, including a historical `serial`
  if (!SELECTABLE_TRACKING_TYPES.includes(next)) {
    throw new BadRequestException(
      `Tracking mode '${next}' can no longer be chosen. Phones are tracked individually by IMEI; everything else is counted by quantity.`,
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
