import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

/**
 * Filters for the sale history of the ACTIVE branch.
 *
 * Every one of these is applied in SQL. A client that filters only the pages it
 * happens to have loaded answers "not found" for a sale that exists — which, on
 * a screen someone opens to settle an argument with a customer holding a
 * receipt, is worse than no search at all.
 */
export class ListSalesDto {
  /**
   * Free text across everything a person might remember about a sale: the
   * number on the receipt, the number printed on the phone, what the thing was,
   * or who sold it.
   */
  @ApiPropertyOptional({ example: '356938035643809' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;

  /**
   * One or more payment statuses, comma-separated. Absent means all — a history
   * screen that hid credit sales would hide exactly the ones somebody is
   * chasing.
   */
  @ApiPropertyOptional({ example: 'partial,credit' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  payStatus?: string;

  /** One or more payment methods, comma-separated (cash, card, mobile, bank, other). */
  @ApiPropertyOptional({ example: 'cash,card' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  paymentMethod?: string;

  /**
   * Inclusive start of the sold-at range, as a date or an instant. A bare date
   * is read as **the whole of that day** in the server's zone, because someone
   * asking for "the 3rd" means the day, not midnight exactly.
   */
  @ApiPropertyOptional({ example: '2026-08-03' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  /** Inclusive end of the sold-at range. A bare date includes that entire day. */
  @ApiPropertyOptional({ example: '2026-08-03' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  /** Opaque keyset cursor from the previous page. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cursor?: string;

  /**
   * A query parameter arrives as a STRING, and the global pipe runs with
   * `enableImplicitConversion: false`, so `@IsInt()` alone would reject every
   * value a client could actually send — `?limit=3` was a 400 on the transfers
   * list until a live request proved it. The explicit transform is what makes
   * the parameter usable.
   */
  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
