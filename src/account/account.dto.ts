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
}

export class ConfirmPhoneVerificationDto {
  @IsUUID() challengeId: string;

  @IsString() @Matches(/^\d{6}$/) code: string;
}
