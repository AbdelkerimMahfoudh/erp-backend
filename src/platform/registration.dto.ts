import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { IsIdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { IsArabicName, IsLatinNameOrLegacy, NormalizeName } from '../common/bilingual-name';
import { ACTIVITIES, type Activity } from '../entitlement/activity';
import { REFERRAL_TOKEN_LENGTH } from '../acquisition/referral-token';

/**
 * A business registering itself, and finishing its registration (docs/68; 0095).
 *
 * One set of bodies for both doors to the same flow — the website's `platform/register*` and the app's
 * `auth/register*` — so the two can never accept different things.
 */

export class RegisterDto {
  /** The client's own key, so a retry cannot create a second business. */
  @IsString() @IsIdempotencyKey() idempotencyKey: string;

  /**
   * D225: each name in the Latin alphabet, with its Arabic twin. The twins are optional here only because the
   * released app (1.0.0 (1)) sends one name per field; a client that sends a twin is held to both rules
   * ({@link IsLatinNameOrLegacy}).
   */
  @IsString() @NormalizeName() @IsLatinNameOrLegacy('ownerNameAr') ownerName: string;
  @IsOptional() @NormalizeName() @IsArabicName() ownerNameAr?: string;
  @IsString() @NormalizeName() @IsLatinNameOrLegacy('businessNameAr') businessName: string;
  @IsOptional() @NormalizeName() @IsArabicName() businessNameAr?: string;
  @IsString() @NormalizeName() @IsLatinNameOrLegacy('branchNameAr') branchName: string;
  @IsOptional() @NormalizeName() @IsArabicName() branchNameAr?: string;
  /** What the first branch does (D154): electronics when not said. */
  @IsOptional() @IsIn(ACTIVITIES) activity?: Activity;

  @IsOptional() @IsString() @MaxLength(120) city?: string;
  /** Optional (0099): verified later, from the account, if the Owner wants email as a second channel. */
  @IsOptional() @IsString() @MaxLength(160) email?: string;
  /**
   * The Owner's WhatsApp number — mandatory (0099; the owner's brief of 2026-10-18): it is the contact the
   * registration verifies, the one the portal instructions and every subscription message go to first, and what the
   * free trial waits for.
   */
  @IsString() @MinLength(6) @MaxLength(24) phone: string;

  @IsString() @MinLength(8) @MaxLength(200) password: string;
  @IsIn(['en', 'ar', 'fr']) language: 'en' | 'ar' | 'fr';

  /**
   * The version of the operational WhatsApp consent the person ticked (`GET messaging/whatsapp/consent`; D213).
   * Required: the server refuses a missing or earlier version with `whatsapp_consent_required` /
   * `whatsapp_consent_outdated`, and nothing is saved. Optional here only so that refusal carries its stable code.
   */
  @IsOptional() @IsString() @MaxLength(40) whatsappConsentVersion?: string;
  /** The language the consent was shown in; the registration's `language` when not said. */
  @IsOptional() @IsIn(['en', 'ar', 'fr']) whatsappConsentLocale?: 'en' | 'ar' | 'fr';

  /**
   * Where the business came from, if anywhere (0103, D221) — at most one: a promoter's six-digit code (ASCII or Arabic
   * digits), or the `r` of a registration link (a promoter's QR or a user's invitation). Both at once is refused with
   * `acquisition_conflict`; a source that is no longer usable with `acquisition_unavailable`, and nothing is saved.
   * Optional: a registration without one is exactly the registration it always was. Never logged.
   */
  @IsOptional() @IsString() @MaxLength(20) promoCode?: string;
  @IsOptional() @IsString() @MaxLength(REFERRAL_TOKEN_LENGTH + 8) referralToken?: string;
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
