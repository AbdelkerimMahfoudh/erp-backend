import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { IsMoney } from '../../common/money/is-money.decorator';

/**
 * One provider float's count at the closing of an agent branch (D154, docs/73
 * §4.5) — the float's own `RecordCountDto`: one provider at a time, counted or
 * skipped with a reason, never both. The expected figure is the server's: what
 * the app tracked at the count instant, or unknown.
 */
export class RecordFloatCountDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  providerId: string;

  /** What the provider's app showed. Zero is a real count; absent means not counted. */
  @ApiPropertyOptional({ minimum: 0, description: 'The float as the provider’s app shows it now' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsMoney({ min: 0 })
  counted?: number;

  @ApiPropertyOptional({ maxLength: 255, description: 'Why the figures differ, when the person knows' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  explanation?: string;

  @ApiPropertyOptional({ description: 'Skip this float instead of counting it' })
  @IsOptional()
  @IsBoolean()
  skip?: boolean;

  @ApiPropertyOptional({ maxLength: 255, description: 'Required when `skip` is true' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  skipReason?: string;
}
