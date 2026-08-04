import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TrackingType } from '@prisma/client';
import { IsArray, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { AttributeDef } from '../../tracking/attribute-def';

export class CreateCategoryDto {
  @ApiProperty({ maxLength: 80, example: 'Laptops' })
  @IsString()
  @MaxLength(80)
  name: string;

  @ApiProperty({ enum: TrackingType, description: 'Default tracking type for products in this category.' })
  @IsEnum(TrackingType)
  defaultTrackingType: TrackingType;

  @ApiPropertyOptional({
    description: 'Ordered adaptive attribute definitions (text/number/enum/measurement).',
    example: [
      { key: 'cpu', label: 'CPU', type: 'text' },
      { key: 'ram', label: 'RAM', type: 'measurement', unit: 'GB', required: true },
      { key: 'resolution', label: 'Resolution', type: 'enum', options: ['FHD', '4K'] },
    ],
  })
  @IsOptional()
  @IsArray()
  attributeSchema?: AttributeDef[];
}
