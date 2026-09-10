import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsNumber, IsOptional, Min } from 'class-validator';
import { IsMoney } from '../../common/money/is-money.decorator';

export class CreateClosingDto {
  /**
   * Optional since E-CP1. If somebody already entered the cash count through
   * `closing.count`, that count is the record and this must not silently
   * replace it — a figure entered by the person holding the drawer is not
   * something the sign-off step should be able to overwrite in passing.
   *
   * Required only when no cash count was recorded, which keeps the original
   * one-step closing working exactly as before.
   */
  @ApiPropertyOptional({ minimum: 0, description: 'Cash counted in the till at closing' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsMoney({ min: 0 })
  countedCash?: number;

  @ApiPropertyOptional({ format: 'date', description: 'Day to close; defaults to today (UTC)' })
  @IsOptional()
  @IsDateString()
  date?: string;
}
