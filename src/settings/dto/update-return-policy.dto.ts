import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { RETURN_WINDOW_MAX_HOURS, RETURN_WINDOW_NONE } from '../settings.constants';
import { POLICY_LANGUAGES } from '../return-policy-rules';

/** The active branch's return policy (0108). Texts are the shop's own words; none is translated. */
export class UpdateReturnPolicyDto {
  @ApiProperty({ minimum: RETURN_WINDOW_NONE, maximum: RETURN_WINDOW_MAX_HOURS, description: '0 = no returns; otherwise hours.' })
  @IsInt()
  @Min(RETURN_WINDOW_NONE)
  @Max(RETURN_WINDOW_MAX_HOURS)
  windowHours!: number;

  // The bound here is generous; the service measures the NORMALISED text against 1000.
  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  textEn?: string | null;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  textFr?: string | null;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  textAr?: string | null;

  @ApiProperty({ enum: POLICY_LANGUAGES })
  @IsIn(POLICY_LANGUAGES as unknown as string[])
  defaultLanguage!: string;

  /** The version the editor read; a concurrent change is refused rather than overwritten. Omitted for a first policy. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  expectedVersion?: number;
}
