import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';
import { IsDateString, IsEnum, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { IsMoney } from '../../common/money/is-money.decorator';

/**
 * Money received later against a sale's balance (0074).
 *
 * The application does not collect this money. It records money an employee
 * confirms has ALREADY been received — no payment provider is called, and a
 * pending or failed attempt is simply never submitted.
 */
export class RecordSalePaymentDto {
  /**
   * One key per attempt, reused on every retry. The same key with the same
   * payload returns the same result; the same key with a different payload is
   * refused, so a retry can never record the money twice.
   */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  clientUuid: string;

  @ApiProperty({ minimum: 0.01, description: 'Money received. Never more than what is still owed.' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @IsMoney({ min: 0.01 })
  amount: number;

  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  /** Required for anything but cash, and it must be an ACTIVE account. */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  receivingAccountId?: string;

  /**
   * When the money was handed over. Defaults to now. It may be earlier today
   * or on an earlier open day, never in the future, never before the sale, and
   * never on a day whose closing is already signed off.
   */
  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  paidAt?: string;

  @ApiPropertyOptional({ maxLength: 80, description: 'A transaction number or receipt the customer quoted.' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  reference?: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}
