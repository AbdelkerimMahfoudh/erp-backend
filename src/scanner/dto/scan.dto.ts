import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class ScanDto {
  @ApiProperty({ description: 'Any scanned/typed identifier: IMEI, barcode, or serial.', maxLength: 128 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  code: string;

  /**
   * The other IMEI on a dual-SIM handset, when one has already been captured.
   *
   * Optional, and never a second lookup: a dual-SIM phone is ONE unit carrying
   * two numbers, so both are checked against inventory together. Sending them
   * separately is how two identifiers on one box end up attached to two
   * different units — the exact mistake `conflictingUnits` exists to catch.
   */
  @ApiPropertyOptional({ description: 'Second IMEI of the same physical phone.', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  secondary?: string;
}
