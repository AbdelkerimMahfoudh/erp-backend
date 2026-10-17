import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { IsIdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { ACTIVITIES, type Activity } from '../entitlement/activity';

/**
 * A business registering itself, and finishing its registration (docs/68; 0095).
 *
 * One set of bodies for both doors to the same flow — the website's `platform/register*` and the app's
 * `auth/register*` — so the two can never accept different things.
 */

export class RegisterDto {
  /** The client's own key, so a retry cannot create a second business. */
  @IsString() @IsIdempotencyKey() idempotencyKey: string;

  @IsString() @MinLength(1) @MaxLength(160) ownerName: string;
  @IsString() @MinLength(1) @MaxLength(160) businessName: string;
  @IsString() @MinLength(1) @MaxLength(160) branchName: string;
  /** What the first branch does (D154): electronics when not said. */
  @IsOptional() @IsIn(ACTIVITIES) activity?: Activity;

  @IsOptional() @IsString() @MaxLength(120) city?: string;
  @IsOptional() @IsString() @MaxLength(160) email?: string;
  @IsOptional() @IsString() @MaxLength(24) phone?: string;

  @IsString() @MinLength(8) @MaxLength(200) password: string;
  @IsIn(['en', 'ar', 'fr']) language: 'en' | 'ar' | 'fr';

  /**
   * The version of the WhatsApp consent copy the person agreed to (`GET messaging/whatsapp/consent`; D181 §5), when
   * a WhatsApp number is given. Required while WhatsApp runs live; a stale version is always refused.
   */
  @IsOptional() @IsString() @MaxLength(40) whatsappConsentVersion?: string;
}

export class ContinueStartDto {
  /** The opaque continuation minted by registration. Never logged. */
  @IsString() @MinLength(16) @MaxLength(200) continuation: string;
  @IsIn(['en', 'ar', 'fr']) language: 'en' | 'ar' | 'fr';
}

export class ContinueConfirmDto {
  @IsString() @MinLength(16) @MaxLength(200) continuation: string;
  @IsString() @MinLength(1) @MaxLength(12) code: string;
}
