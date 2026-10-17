import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

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

  /** The WhatsApp consent version agreed to (D181 §5). Required while WhatsApp runs live; a stale one is refused. */
  @IsOptional() @IsString() @MaxLength(40) whatsappConsentVersion?: string;
}

/** Stop optional WhatsApp notifications, or withdraw WhatsApp as the account contact (D181 §5). */
export class WhatsAppOptOutDto {
  @IsIn(['optional', 'all']) scope: 'optional' | 'all';

  @IsOptional() @IsIn(ACCOUNT_LANGUAGES) language?: AccountLanguage;
}

/** Agree to the current WhatsApp consent copy for my verified number. */
export class WhatsAppConsentDto {
  @IsString() @MaxLength(40) version: string;
}

export class ConfirmPhoneVerificationDto {
  @IsUUID() challengeId: string;

  @IsString() @Matches(/^\d{6}$/) code: string;
}
