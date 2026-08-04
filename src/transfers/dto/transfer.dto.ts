import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class CreateTransferDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  toBranchId: string;

  @ApiProperty({ type: [String], description: 'Unit identifiers (IMEI or serial)', example: ['123456789012347'] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  identifiers: string[];
}

export class ReceiveTransferDto {
  @ApiProperty({ type: [String], description: 'Scanned identifiers at the destination (may be empty)' })
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  identifiers: string[];
}

export class SetTransferPrefixDto {
  @ApiProperty({ example: 'NKC', maxLength: 8, description: 'Uppercase alphanumeric; empty clears it' })
  @IsString()
  @MaxLength(8)
  @Matches(/^[A-Z0-9]{0,8}$/, { message: 'prefix must be up to 8 uppercase letters/digits' })
  prefix: string;
}
