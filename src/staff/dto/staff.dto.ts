import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

export const STAFF_ROLES = ['store_manager', 'store_employee'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const STAFF_PASSWORD_MIN_LENGTH = 8;

/** An Owner creates an employee account from Team (docs/21, 2026-10-05). */
export class CreateStaffDto {
  @ApiProperty({ maxLength: 160 })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name: string;

  @ApiPropertyOptional({
    maxLength: 160,
    description: 'Email address. Optional: never a condition of activation, and verified later if at all (D214).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  email?: string;

  @ApiProperty({
    maxLength: 24,
    description: 'WhatsApp number in international format. Required: the employee proves it from their invitation (D214).',
  })
  @IsString()
  @MinLength(6)
  @MaxLength(24)
  phone: string;

  @ApiProperty({
    type: [String],
    description: 'The stores this person works at. One seat is needed at each.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  branchIds: string[];

  @ApiProperty({ enum: STAFF_ROLES })
  @IsIn(STAFF_ROLES)
  role: StaffRole;

  /** Accepted and ignored from older clients: creating an account sends no message (D214). */
  @ApiPropertyOptional({ enum: ['en', 'ar', 'fr'], deprecated: true })
  @IsOptional()
  @IsIn(['en', 'ar', 'fr'])
  language?: 'en' | 'ar' | 'fr';
}

/** The employee opens their invitation (D214): the reference the Owner gave them. */
export class StaffJoinOpenDto {
  @ApiProperty({ maxLength: 40, description: 'The invitation reference, as shown to the Owner (e.g. K7QM-9XRT-2CHD).' })
  @IsString()
  @MinLength(8)
  @MaxLength(40)
  reference: string;
}

/** The employee asks for their code: their number, typed, and their own operational WhatsApp consent (D213, D214). */
export class StaffJoinRequestCodeDto extends StaffJoinOpenDto {
  @ApiProperty({ maxLength: 24, description: 'The WhatsApp number the Owner entered — typed by the employee, never shown to them.' })
  @IsString()
  @MinLength(6)
  @MaxLength(24)
  number: string;

  @ApiPropertyOptional({ enum: ['en', 'ar', 'fr'] })
  @IsOptional()
  @IsIn(['en', 'ar', 'fr'])
  language?: 'en' | 'ar' | 'fr';

  /** The version of the consent copy the employee ticked. Required: refused `whatsapp_consent_required` / `_outdated`. */
  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  whatsappConsentVersion?: string;

  /** The language the consent was shown in; `language` when not said. */
  @ApiPropertyOptional({ enum: ['en', 'ar', 'fr'] })
  @IsOptional()
  @IsIn(['en', 'ar', 'fr'])
  whatsappConsentLocale?: 'en' | 'ar' | 'fr';
}

/** The employee's code, and their first password. */
export class StaffJoinConfirmDto extends StaffJoinOpenDto {
  @ApiProperty()
  @IsString()
  @Length(4, 12)
  code: string;

  @ApiPropertyOptional({ minLength: STAFF_PASSWORD_MIN_LENGTH, description: 'Required the first time.' })
  @IsOptional()
  @IsString()
  @MinLength(STAFF_PASSWORD_MIN_LENGTH)
  @MaxLength(200)
  password?: string;
}
