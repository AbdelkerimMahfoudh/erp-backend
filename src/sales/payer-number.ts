import { BadRequestException } from '@nestjs/common';

/**
 * The payer number (docs/21 D151, 0087): the phone or account number a bank or
 * wallet payment came FROM — typed at the till, optional, never verified by any
 * provider. Not the transfer's `reference`, not the customer's saved phone, not
 * the account the money reached.
 *
 * The same rule as the app's `erp-mobile/lib/payer-number.ts`; the server never
 * trusts the app's copy. Accepted: an optional leading `+`, then digits, with
 * the spaces and hyphens a person types to group them. Normalised as
 * presentation only: Arabic-Indic and Extended Arabic-Indic digits read as the
 * same digits; spaces of any kind, hyphens and dashes of any kind, and invisible
 * direction marks are dropped. Never: a digit added, removed or changed — `00`
 * is not turned into `+`, and no country code is guessed. Refused: any other
 * character, a `+` anywhere but first, visible text with no digit, more than
 * {@link PAYER_NUMBER_MAX_DIGITS} digits.
 *
 * Refusals name the problem, never the number: exception messages reach the
 * server log, and the number is a person's contact detail.
 */

/** Characters accepted in the request, as typed. */
export const PAYER_NUMBER_MAX_INPUT = 40;
/** Digits kept: longer than any phone (15) or bank account number in use here. */
export const PAYER_NUMBER_MAX_DIGITS = 30;

export type ParsedPayerNumber = { ok: true; value: string | null } | { ok: false; reason: 'invalid' | 'too_long' };

const SPACES = /\s/gu;
const DASHES = /[-‐-―−﹘﹣－]/g;
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;

export function parsePayerNumber(raw: string | null | undefined): ParsedPayerNumber {
  const visible = (raw ?? '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/＋/g, '+')
    .replace(INVISIBLE, '')
    .replace(SPACES, '');
  // Blank is "no payer number"; anything visible must hold a number — a lone hyphen is a slip, not an empty field.
  if (visible === '') return { ok: true, value: null };
  const text = visible.replace(DASHES, '');
  if (!/^\+?[0-9]+$/.test(text)) return { ok: false, reason: 'invalid' };
  const digits = text.startsWith('+') ? text.length - 1 : text.length;
  if (digits > PAYER_NUMBER_MAX_DIGITS) return { ok: false, reason: 'too_long' };
  return { ok: true, value: text };
}

/**
 * One payment's payer number as it is stored, or the refusal (400).
 *
 * Cash never carries one — the drawer was paid in notes, and
 * `ck_payments_cash_no_payer` refuses it too — so a number sent with cash is
 * refused rather than silently dropped: it means the till got the method wrong.
 */
export function payerNumberFor(method: string, raw: string | null | undefined): string | null {
  const parsed = parsePayerNumber(raw);
  if (!parsed.ok) {
    throw new BadRequestException({
      code: 'payer_number_invalid',
      message:
        parsed.reason === 'too_long'
          ? `A payer number has at most ${PAYER_NUMBER_MAX_DIGITS} digits`
          : 'A payer number is digits, with spaces or hyphens and an optional leading +',
    });
  }
  if (parsed.value !== null && method === 'cash') {
    throw new BadRequestException({ code: 'payer_number_cash', message: 'A cash payment has no payer number' });
  }
  return parsed.value;
}

/** Every part of a sale's money checked before anything is written; each part keeps its own number. */
export function assertPayerNumbers(payments: { method: string; payerNumber?: string | null }[]): void {
  for (const p of payments) payerNumberFor(p.method, p.payerNumber);
}
