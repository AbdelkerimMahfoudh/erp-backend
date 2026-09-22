import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { IsMoney } from '../../common/money/is-money.decorator';

/**
 * Correcting one in-stock unit.
 *
 * A correction fixes what was entered wrong when the unit was received — a
 * mistyped IMEI, the wrong product, a cost off by a digit. It is deliberately
 * NOT a general editor:
 *
 *  - **The product is re-associated, not rewritten.** `productId` moves the unit
 *    to the correct catalogue entry, which is what fixes its model, variant,
 *    storage, colour and barcode in one honest move. Editing the shared product
 *    row itself is `catalog.manage`'s job and would rewrite every other unit and
 *    every past sale of it.
 *  - **Only the unit's own identifier columns are touched.** An IMEI has no path
 *    to the product barcode field, because barcode is not a unit column and is
 *    not in this payload.
 *  - **The branch never changes here** — that is a transfer — and neither does
 *    the status: a faulty unit has its own route, and a sold or reserved unit is
 *    not correctable at all.
 *
 * Every field is optional; sending only the ones that changed is a correction of
 * exactly those. Which identifier fields are meaningful is decided by the
 * product's tracking type, on the server — the client never picks a mode.
 */
export class CorrectUnitDto {
  /**
   * The `updatedAt` the client last read for this unit — its optimistic-lock
   * token. The write only lands if the unit has not moved since, so a
   * correction can never silently overwrite another person's concurrent change.
   * There is no `version` column; `updatedAt` is the compare-and-swap value.
   */
  @ApiProperty({ description: 'The unit’s updatedAt as last read, for optimistic concurrency', format: 'date-time' })
  @IsDateString()
  expectedUpdatedAt: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Re-associate the unit with the correct catalogue product' })
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional({ description: 'Corrected primary IMEI (imei-tracked products only)', example: '350000000000006' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  imeiPrimary?: string;

  /**
   * Corrected secondary IMEI, or `null` to clear it (a dual-SIM correction).
   * `undefined` leaves it exactly as it was.
   */
  @ApiPropertyOptional({ nullable: true, description: 'Corrected secondary IMEI, or null to clear', example: '350000000000014' })
  @IsOptional()
  @ValidateIf((o: CorrectUnitDto) => o.imeiSecondary !== null)
  @Matches(/^\d{15}$/, { message: 'imeiSecondary must be 15 digits' })
  imeiSecondary?: string | null;

  @ApiPropertyOptional({ description: 'Corrected serial number (serial-tracked products only)' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  serialNo?: string;

  @ApiPropertyOptional({ minimum: 0.01, description: 'Corrected per-unit purchase cost (requires cost.view)' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @IsMoney({ min: 0.01 })
  cost?: number;

  /**
   * Why the correction was made. Required whenever a sensitive value — an IMEI,
   * a serial number or the cost — changes, so the audit trail says not just what
   * moved but why. Recorded on the audit entry, never on the unit.
   */
  @ApiPropertyOptional({ description: 'Reason for the correction (required for IMEI / serial / cost changes)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
