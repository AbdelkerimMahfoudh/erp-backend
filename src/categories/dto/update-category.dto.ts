import { ApiPropertyOptional } from '@nestjs/swagger';
import { TrackingType } from '@prisma/client';
import { IsArray, IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { AttributeDef } from '../../tracking/attribute-def';

export class UpdateCategoryDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ enum: TrackingType })
  @IsOptional()
  @IsEnum(TrackingType)
  defaultTrackingType?: TrackingType;

  @ApiPropertyOptional({ description: 'Replaces the whole attribute schema.' })
  @IsOptional()
  @IsArray()
  attributeSchema?: AttributeDef[];

  @ApiPropertyOptional({ description: 'Retire (false) or restore (true) the category. Categories are never deleted.' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
