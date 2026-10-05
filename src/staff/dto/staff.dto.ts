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
    description: 'Email address. Verified before the account can be used.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  email?: string;

  @ApiPropertyOptional({
    maxLength: 24,
    description: 'WhatsApp number in international format. Verified before the account can be used.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  phone?: string;

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

  @ApiPropertyOptional({
    enum: ['en', 'ar', 'fr'],
    description: 'The language of the verification message.',
  })
  @IsOptional()
  @IsIn(['en', 'ar', 'fr'])
  language?: 'en' | 'ar' | 'fr';
}

export class ResendStaffVerificationDto {
  @ApiProperty({ enum: ['email', 'phone'] })
  @IsIn(['email', 'phone'])
  channel: 'email' | 'phone';
}

/** The invited person proves a contact and chooses their password. */
export class StaffVerifyConfirmDto {
  @ApiProperty({
    maxLength: 160,
    description: 'The email address or WhatsApp number the code was sent to.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(160)
  destination: string;

  @ApiProperty()
  @IsString()
  @Length(4, 12)
  code: string;

  @ApiPropertyOptional({
    minLength: STAFF_PASSWORD_MIN_LENGTH,
    description: 'Required the first time a contact is proven.',
  })
  @IsOptional()
  @IsString()
  @MinLength(STAFF_PASSWORD_MIN_LENGTH)
  @MaxLength(200)
  password?: string;
}

export class StaffVerifyResendDto {
  @ApiProperty({ maxLength: 160 })
  @IsString()
  @MinLength(3)
  @MaxLength(160)
  destination: string;

  @ApiPropertyOptional({ enum: ['en', 'ar', 'fr'] })
  @IsOptional()
  @IsIn(['en', 'ar', 'fr'])
  language?: 'en' | 'ar' | 'fr';
}
