import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Matches, Min } from 'class-validator';

/**
 * Teaching a company its own TAC→Product mapping.
 *
 * There is no `status` field, deliberately. Whether this is a proposal or a
 * confirmation is decided by the caller's permission, not by the client —
 * letting the client assert it would make "am I allowed to confirm?" a question
 * the client could answer wrongly.
 */
export class SubmitTacMappingDto {
  @ApiProperty({ description: 'Exactly eight digits — the first eight of an IMEI.' })
  @Matches(/^\d{8}$/, { message: 'A TAC is exactly eight digits.' })
  tac!: string;

  @ApiProperty({ description: "The company's own Product. Another company's id is a 404." })
  @IsUUID()
  productId!: string;

  @ApiPropertyOptional({ description: 'Where the evidence came from: receiving, scan, sale, manual.' })
  @IsOptional()
  @IsString()
  evidenceSource?: string;

  @ApiPropertyOptional({
    description:
      'Required only when replacing an existing CONFIRMED mapping. A stale value is a 409, so two managers deciding at once produce one winner.',
  })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}
