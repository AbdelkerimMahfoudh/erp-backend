import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReceivingProvider } from '@prisma/client';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { Optional } from './optional.decorator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateReceivingAccountDto {
  @ApiProperty({ enum: ReceivingProvider })
  @IsEnum(ReceivingProvider)
  provider: ReceivingProvider;

  @ApiPropertyOptional({
    maxLength: 60,
    description: 'Required when provider is `other`; rejected otherwise.',
  })
  @Optional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  providerName?: string;

  @ApiProperty({
    maxLength: 80,
    example: 'Bankily – Main Counter',
    description: 'What the employee reads at the till. Must be unique within the company.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'A label is required — "Bankily" three times over is not a choice anyone can make.' })
  @MaxLength(80)
  label: string;
}

export class UpdateReceivingAccountDto {
  @ApiProperty({ description: 'The account `version` you loaded. A stale value is rejected with 409.' })
  @IsInt()
  @Min(0)
  version: number;

  @ApiPropertyOptional({ enum: ReceivingProvider })
  @Optional()
  @IsEnum(ReceivingProvider)
  provider?: ReceivingProvider;

  @ApiPropertyOptional({ maxLength: 60 })
  @Optional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  providerName?: string;

  @ApiPropertyOptional({ maxLength: 80 })
  @Optional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  label?: string;

  @ApiPropertyOptional({
    description: 'Set false to deactivate. Accounts are never deleted, so past money movement stays attributable.',
  })
  @Optional()
  @IsBoolean()
  isActive?: boolean;
}

export class ReorderReceivingAccountsDto {
  @ApiProperty({
    type: [String],
    description: 'Every account id, in the order they should appear at the till.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  ids: string[];
}
