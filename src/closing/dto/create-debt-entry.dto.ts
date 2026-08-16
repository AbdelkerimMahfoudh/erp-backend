import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  Min,
} from 'class-validator';

/**
 * A repayment, a payroll deduction, or a write-off (E-CP2).
 *
 * `charge` is deliberately absent from the accepted kinds. A charge only ever
 * comes from resolving a real discrepancy — allowing one to be posted directly
 * would be a way to make somebody owe money with no till, no day and no
 * shortage behind it.
 */
export class CreateDebtEntryDto {
  @ApiProperty({ format: 'uuid', description: 'Who the entry is about' })
  @IsUUID()
  userId: string;

  @ApiProperty({ enum: ['repayment', 'deduction', 'forgiveness'] })
  @IsIn(['repayment', 'deduction', 'forgiveness'])
  kind: 'repayment' | 'deduction' | 'forgiveness';

  /** Always a positive magnitude; `kind` carries the direction. */
  @ApiProperty({ minimum: 0.01 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;

  /** Mandatory for every kind. A ledger row nobody can explain is worse than none. */
  @ApiProperty({ minLength: 3, maxLength: 255 })
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  reason: string;

  @ApiPropertyOptional({ enum: ['cash', 'account', 'payroll'], description: 'Required for a repayment' })
  @IsOptional()
  @IsIn(['cash', 'account', 'payroll'])
  method?: 'cash' | 'account' | 'payroll';

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;

  @ApiPropertyOptional({ format: 'date' })
  @IsOptional()
  @IsDateString()
  entryDate?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Idempotency key for an offline retry' })
  @IsOptional()
  @IsUUID()
  clientUuid?: string;
}
