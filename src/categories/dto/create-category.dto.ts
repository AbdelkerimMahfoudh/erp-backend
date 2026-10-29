import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TrackingType } from '@prisma/client';
import { IsArray, IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AttributeDef } from '../../tracking/attribute-def';
import { CATEGORY_ICONS, type CategoryIcon } from '../category-icons';

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

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'A top-level category to file this one under. One level only: a subcategory has no children.',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional({
    enum: CATEGORY_ICONS,
    description: 'The illustration this category wears (D225). Absent: its built-in parent\'s, or a neutral generic one.',
  })
  @IsOptional()
  @IsIn(CATEGORY_ICONS)
  icon?: CategoryIcon;
}
