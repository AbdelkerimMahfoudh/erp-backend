import { BadRequestException, ConflictException } from '@nestjs/common';
import { TrackingType } from '@prisma/client';
import { defaultCategory } from '../catalog/default-categories';

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
 * Since 2026-10-27 (D223) a category RECOMMENDS the mode and the Owner may
 * choose another the category allows (`resolveTrackingType`): a built-in Cables
 * category still cannot become individually tracked, a built-in Phones category
 * cannot be counted, and a shop's own category allows every selectable mode.
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

/** The category facts the rule needs: its recommended mode, and its built-in key when it has one. */
export interface TrackingCategory {
  defaultTrackingType: TrackingType;
  key?: string | null;
}

/**
 * The modes a category lets the Owner choose (D223).
 *
 * A built-in category lists them (`default-categories.ts`): a phone is only ever
 * IMEI-tracked, a cable only ever counted, a tablet IMEI-, serial- or
 * quantity-tracked depending on whether it is cellular. A shop's own category
 * allows every selectable mode — it is the Owner's to decide.
 */
export function allowedTrackingTypes(category: TrackingCategory): readonly TrackingType[] {
  return defaultCategory(category.key)?.allowed ?? SELECTABLE_TRACKING_TYPES;
}

/**
 * The category RECOMMENDS the mode; the Owner may choose another it allows (D223).
 *
 * Until 2026-10-27 the category decided and any other mode was refused. The
 * owner reversed that: a headset, a smartwatch or a tablet is not one universal
 * rule. What stays refused is a mode the category does not allow — a manipulated
 * client still cannot pick Phones and ask for `quantity` to skip the IMEI, nor
 * pick Cables and ask for `imei`. A refusal names the category's mode and the
 * one asked for, so the client can tell which it got wrong.
 */
export function resolveTrackingType(category: TrackingCategory, clientMode?: TrackingType | null): TrackingType {
  if (clientMode === undefined || clientMode === null) return category.defaultTrackingType;
  if (!allowedTrackingTypes(category).includes(clientMode)) {
    throw new BadRequestException(
      `This category is tracked by '${category.defaultTrackingType}', so '${clientMode}' cannot be used. ` +
        `It allows: ${allowedTrackingTypes(category).join(', ')}.`,
    );
  }
  return clientMode;
}

/**
 * The mode a product takes when it is re-filed under another category and the
 * request names no mode: its own, if the new category allows it; else the new
 * category's recommendation (still subject to `assertTrackingChangeSafe`).
 */
export function trackingAfterRecategorise(category: TrackingCategory, current: TrackingType): TrackingType {
  return allowedTrackingTypes(category).includes(current) ? current : category.defaultTrackingType;
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
