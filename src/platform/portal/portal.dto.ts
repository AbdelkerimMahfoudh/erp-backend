import { IsIn, IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

/**
 * The Dukan ERP portal's request bodies (0099; docs/101 §4). Strict like every DTO here — the global pipe refuses an
 * unknown field — and nothing beyond what the person types: the server decides the rest.
 */

/** The same identity as the app: the WhatsApp number or the email address, and the password. */
export class PortalSignInDto {
  @IsString() @IsNotEmpty() @MaxLength(120) identifier: string;
  @IsString() @IsNotEmpty() @MaxLength(200) password: string;
}

/** The same contact and password at more than one business: which one, by the opaque index offered. */
export class PortalChooseAccountDto {
  @IsString() @IsNotEmpty() @MaxLength(4096) continuationToken: string;
  @IsString() @IsNotEmpty() @MaxLength(8) accountRef: string;
}

/** The code sent to the Owner's own email address. */
export class EmailCodeDto {
  @IsString() @Matches(/^\d{4,8}$/) code: string;
}

/** The language the code's message is written in: the portal's own. */
export class EmailVerifyStartDto {
  @IsIn(['en', 'fr', 'ar']) language: 'en' | 'fr' | 'ar';
}
