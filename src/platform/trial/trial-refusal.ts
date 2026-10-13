import { HttpException, HttpStatus } from '@nestjs/common';
import type { TrialContact, TrialView } from './trial-rules';

/**
 * Every refusal of the free trial's routes, with its status and its plain words (0095; docs/76). The website says
 * each in its own words from the code; nothing here is a reason to parse English.
 */
const REFUSALS = {
  owner_only: { status: HttpStatus.FORBIDDEN, message: 'Only the business owner can see or start the free trial.' },
  idempotency_conflict: { status: HttpStatus.CONFLICT, message: 'This request key was already used for a different request.' },
  trial_already_claimed: { status: HttpStatus.CONFLICT, message: 'This business has already used its free trial.' },
  business_closed: { status: HttpStatus.CONFLICT, message: 'This business is closed.' },
  business_suspended: { status: HttpStatus.CONFLICT, message: 'This business is suspended, so the free trial cannot start.' },
  business_refused: { status: HttpStatus.CONFLICT, message: 'This registration was not approved, so the free trial cannot start.' },
  trial_not_available: { status: HttpStatus.CONFLICT, message: 'This business cannot start a free trial.' },
  terms_changed: { status: HttpStatus.CONFLICT, message: 'The free trial terms have changed. Read them again before starting.' },
  contact_unverified: { status: HttpStatus.CONFLICT, message: 'Verify your contact details before starting the free trial.' },
  link_invalid: { status: HttpStatus.BAD_REQUEST, message: 'This link is not valid.' },
  link_expired: { status: HttpStatus.GONE, message: 'This link has expired.' },
  link_used: { status: HttpStatus.CONFLICT, message: 'This link has already been used.' },
  link_revoked: { status: HttpStatus.CONFLICT, message: 'This link no longer works.' },
  link_other_account: { status: HttpStatus.FORBIDDEN, message: 'This link belongs to another business account.' },
} as const;

export type TrialRefusalCode = keyof typeof REFUSALS;

/** The only details a refusal carries — each safe for the Owner to read, and allowlisted by the error filter. */
interface RefusalDetails {
  missingContacts?: TrialContact[];
  termsVersion?: string;
  trial?: TrialView | null;
}

/** A refusal of a trial route: its code, its words, and nothing a caller could not already know. */
export class TrialRefusal extends HttpException {
  constructor(
    readonly code: TrialRefusalCode,
    readonly details: RefusalDetails = {},
  ) {
    super({ code, message: REFUSALS[code].message, ...details }, REFUSALS[code].status);
  }
}
