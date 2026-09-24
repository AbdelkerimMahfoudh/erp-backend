import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsNumber, IsOptional, IsString, IsUUID, Matches, MaxLength, Min } from 'class-validator';
import { IsMoney } from '../../common/money/is-money.decorator';

/**
 * Close the business day on the report the server built (docs/51 D2, D5).
 *
 * Physical checks are optional. A channel that nobody counted (freshly, after any
 * reopen) is closed as NOT VERIFIED — which the person closing must acknowledge,
 * with a reason. Nothing is ever inferred from a missing field: without the
 * acknowledgement a close with an unchecked channel is refused.
 */
export class CreateClosingDto {
  /**
   * The one-step cash count, kept for older clients: a figure entered here IS a
   * count of the drawer, recorded as such. It never replaces a count somebody
   * already recorded through `closing.count`.
   */
  @ApiPropertyOptional({ minimum: 0, description: 'Cash counted in the till at closing (legacy one-step count)' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsMoney({ min: 0 })
  countedCash?: number;

  @ApiPropertyOptional({ format: 'date', description: 'The business date to close; defaults to the branch’s current one' })
  @IsOptional()
  @IsDateString()
  date?: string;

  /** Makes the close safe to retry: the same id replays the close already made. */
  @ApiPropertyOptional({ format: 'uuid', description: 'Idempotency key; a retry with the same id replays the close' })
  @IsOptional()
  @IsUUID()
  clientUuid?: string;

  /** The version of the report the person confirmed; a close on figures that moved since is refused. */
  @ApiPropertyOptional({ description: 'The report version shown to the person confirming' })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{16}$/)
  reportVersion?: string;

  /** "I confirm the physical balances below were not checked." Required when any channel is not verified. */
  @ApiPropertyOptional({ description: 'Acknowledges closing with channels that were not physically verified' })
  @IsOptional()
  @IsBoolean()
  acknowledgeUnverified?: boolean;

  /** Why the balances were not checked. Required with the acknowledgement. */
  @ApiPropertyOptional({ maxLength: 255, description: 'Why the physical balances were not checked' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}
