import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ScanDto {
  @ApiProperty({ description: 'Any scanned/typed identifier: IMEI, barcode, or serial.', maxLength: 128 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  code: string;
}
