import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * The free trial's request bodies (0095; docs/76). Strict like every DTO here (the global pipe refuses unknown fields),
 * and short: the server decides everything else — the instant, the end, the Owner, the contacts.
 */

/** The setup link's token, as long as one can be — the token itself is 43 characters. Never logged, never stored. */
const TOKEN_MIN = 16;
const TOKEN_MAX = 200;

export class ClaimTrialDto {
  /** The website's key for one attempt, kept for that attempt's retries: the same key and request replay the claim. */
  @IsString() @MinLength(1) @MaxLength(80) idempotencyKey: string;

  /** The terms version the website showed. Anything but the current one is refused with the current one. */
  @IsString() @MinLength(1) @MaxLength(40) termsVersion: string;

  /** The setup link's token, when the Owner came from one. Optional: a signed-in eligible Owner never needs it. */
  @IsOptional() @IsString() @MinLength(TOKEN_MIN) @MaxLength(TOKEN_MAX) token?: string;
}

export class TrialLinkDto {
  /** Sent only in this body, after sign-in — no route reads a token from a URL. */
  @IsString() @MinLength(TOKEN_MIN) @MaxLength(TOKEN_MAX) token: string;
}
