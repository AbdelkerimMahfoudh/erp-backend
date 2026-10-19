import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

/** The languages a code may be sent in. The same three the app ships. */
export const ACCOUNT_LANGUAGES = ['en', 'fr', 'ar'] as const;
export type AccountLanguage = (typeof ACCOUNT_LANGUAGES)[number];

export class StartDeletionDto {
  /** The caller's own password: recent proof that the person holding the phone is the account holder. */
  @IsString() @MinLength(1) @MaxLength(200) password: string;

  /** The client's key for this request, so a retry returns the same request rather than a second code. */
  @IsOptional() @IsUUID() clientUuid?: string;

  @IsOptional() @IsIn(ACCOUNT_LANGUAGES) language?: AccountLanguage;
}

export class ResendDeletionCodeDto {
  @IsOptional() @IsIn(ACCOUNT_LANGUAGES) language?: AccountLanguage;
}

export class ConfirmDeletionDto {
  /** Six digits. Anything else never reaches a hash. */
  @IsString() @Matches(/^\d{6}$/) code: string;
}

export class StartPhoneVerificationDto {
  /** The WhatsApp number to prove, as typed. Normalised on the server. */
  @IsString() @MinLength(4) @MaxLength(32) phone: string;

  @IsString() @MinLength(1) @MaxLength(200) password: string;

  @IsOptional() @IsIn(ACCOUNT_LANGUAGES) language?: AccountLanguage;

  /** The operational WhatsApp consent version ticked for this number (D213): required, the current one only. */
  @IsOptional() @IsString() @MaxLength(40) whatsappConsentVersion?: string;

  /** The language the consent was shown in; `language` when not said. */
  @IsOptional() @IsIn(ACCOUNT_LANGUAGES) whatsappConsentLocale?: AccountLanguage;
}

/** Agree to the copy in force for my verified number (D213). */
export class WhatsAppConsentDto {
  @IsString() @MaxLength(40) version: string;

  /** The language the copy was shown in. */
  @IsOptional() @IsIn(ACCOUNT_LANGUAGES) locale?: AccountLanguage;
}

/** Withdraw my operational WhatsApp consent (D213). */
export class WithdrawWhatsAppConsentDto {
  /** Required when WhatsApp is my only verified contact: I understood that recovery then goes through support. */
  @IsOptional() @IsBoolean() acknowledgeSupportRecovery?: boolean;
}

export class ConfirmPhoneVerificationDto {
  @IsUUID() challengeId: string;

  @IsString() @Matches(/^\d{6}$/) code: string;
}
