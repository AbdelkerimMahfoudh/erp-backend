import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  Min,
} from 'class-validator';
import { IsMoney } from '../../common/money/is-money.decorator';

export class CreateLoanDto {
  @ApiProperty({ format: 'uuid', description: 'Who the loan is with' })
  @IsUUID()
  counterpartyId: string;

  /**
   * Explicit, never inferred from a sign. `they_owe_us` and `we_owe_them` are
   * different facts, and a negative amount would become ambiguous the moment
   * somebody corrects a payment.
   */
  @ApiProperty({ enum: ['they_owe_us', 'we_owe_them'] })
  @IsIn(['they_owe_us', 'we_owe_them'])
  direction: 'they_owe_us' | 'we_owe_them';

  @ApiProperty({ minimum: 0.01, description: 'What you are proposing' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @IsMoney({ min: 0.01 })
  amount: number;

  @ApiPropertyOptional({ maxLength: 255, description: 'What it is for' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Idempotency key for an offline retry' })
  @IsOptional()
  @IsUUID()
  clientUuid?: string;
}

export class DecideLoanDto {
  @ApiProperty({ enum: ['accept', 'counter', 'dispute', 'reject', 'cancel'] })
  @IsIn(['accept', 'counter', 'dispute', 'reject', 'cancel'])
  action: 'accept' | 'counter' | 'dispute' | 'reject' | 'cancel';

  @ApiPropertyOptional({ minimum: 0.01, description: 'Required for a counter-offer' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @IsMoney({ min: 0.01 })
  amount?: number;

  /** Mandatory for a dispute: bare disagreement is not something to act on. */
  @ApiPropertyOptional({ maxLength: 255, description: 'Required when disputing' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  expectedVersion?: number;
}

export class LoanPaymentDto {
  @ApiProperty({ enum: ['report', 'confirm', 'correct'] })
  @IsIn(['report', 'confirm', 'correct'])
  action: 'report' | 'confirm' | 'correct';

  @ApiPropertyOptional({ minimum: 0.01, description: 'Required when reporting' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @IsMoney({ min: 0.01 })
  amount?: number;

  @ApiPropertyOptional({ enum: ['cash', 'account'] })
  @IsOptional()
  @IsIn(['cash', 'account'])
  method?: 'cash' | 'account';

  @ApiPropertyOptional({ format: 'uuid', description: 'Required when the method is account' })
  @IsOptional()
  @IsUUID()
  receivingAccountId?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;

  /**
   * A photo or document reference. **Not proof** — nothing external is checked,
   * and the screens must never present it as verification of payment.
   */
  @ApiPropertyOptional({ maxLength: 512, description: 'Evidence reference; still not proof' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  evidenceRef?: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;

  /**
   * Why a confirmed payment is being reversed. Mandatory for `correct`.
   *
   * A reversal puts a settled debt back, which is the most consequential thing
   * anybody does to a loan record — Milestone B established that it must always
   * carry an explanation.
   */
  @ApiPropertyOptional({ maxLength: 255, description: 'Required when correcting' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;

  /** Which entry is being confirmed, or reversed. */
  @ApiPropertyOptional({ format: 'uuid', description: 'Required to confirm or correct' })
  @IsOptional()
  @IsUUID()
  entryId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  clientUuid?: string;
}

export class ForgiveLoanDto {
  @ApiProperty({ minimum: 0.01 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @IsMoney({ min: 0.01 })
  amount: number;

  /** Mandatory. A write-off nobody can explain is money quietly disappearing. */
  @ApiProperty({ minLength: 3, maxLength: 255 })
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  reason: string;
}
