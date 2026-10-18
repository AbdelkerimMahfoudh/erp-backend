import { IsString, MaxLength, MinLength } from 'class-validator';
import { IsIdempotencyKey } from '../../common/decorators/idempotency-key.decorator';

/**
 * The free trial's request body (0095, 0099; docs/76). Strict like every DTO here (the global pipe refuses unknown
 * fields, a token among them), and short: the server decides everything else — the instant, the end, the Owner, the
 * contacts.
 */
export class ClaimTrialDto {
  /** The portal's key for one attempt, kept for that attempt's retries: the same key and request replay the claim. */
  @IsString() @IsIdempotencyKey() idempotencyKey: string;

  /** The terms version the portal showed. Anything but the current one is refused with the current one. */
  @IsString() @MinLength(1) @MaxLength(40) termsVersion: string;
}
