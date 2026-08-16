import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Min,
} from 'class-validator';

/**
 * Reporting an expense. **Reporting moves no money** — only an Owner's
 * confirmation does.
 *
 * There is no `status` field: the lifecycle is the server's, and a client that
 * could assert "confirmed" would be asserting an authority it may not have.
 */
export class CreateExpenseDto {
  @ApiProperty({ description: 'What the money was for, in the shop’s own words.' })
  @IsString()
  @Length(1, 60)
  category!: string;

  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @ApiPropertyOptional({
    enum: ['variable', 'fixed'],
    description:
      'A VARIABLE expense belongs to the day it is confirmed. A FIXED one belongs to its due date and is never spread across every day.',
  })
  @IsOptional()
  @IsEnum(['variable', 'fixed'])
  expenseClass?: 'variable' | 'fixed';

  @ApiPropertyOptional({ description: 'Salaries stay separately reportable. Fixed only.' })
  @IsOptional()
  @IsBoolean()
  isSalary?: boolean;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD. Required for a fixed expense, forbidden for a variable one.' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dueDate?: string;

  @ApiPropertyOptional({ enum: ['cash', 'account'], description: 'Only cash touches the drawer.' })
  @IsOptional()
  @IsEnum(['cash', 'account'])
  method?: 'cash' | 'account';

  @ApiPropertyOptional({ description: 'Required when the method is account; must be an ACTIVE account.' })
  @IsOptional()
  @IsUUID()
  receivingAccountId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 120)
  reference?: string;

  @ApiPropertyOptional({ description: 'Why. Its absence is what triggers the confirmation warning.' })
  @IsOptional()
  @IsString()
  note?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD. Continuity only; the accounting date is set by the server.' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  spentOn?: string;

  @ApiPropertyOptional({ description: 'Idempotency key. An offline retry must not record two expenses.' })
  @IsOptional()
  @IsUUID()
  clientUuid?: string;
}

/** Confirming or rejecting. */
export class DecideExpenseDto {
  @ApiProperty({ description: 'The version the caller last read. A stale one is a 409.' })
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ApiPropertyOptional({
    description:
      'Set when the Owner confirmed after being warned that no reason was given. Stored as an explicit state, never as placeholder copy.',
  })
  @IsOptional()
  @IsBoolean()
  reasonOmitted?: boolean;

  @ApiPropertyOptional({ description: 'Why it was rejected.' })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  reason?: string;
}

export class ListExpensesDto {
  @ApiPropertyOptional({ enum: ['reported', 'confirmed', 'rejected'] })
  @IsOptional()
  @IsEnum(['reported', 'confirmed', 'rejected'])
  status?: 'reported' | 'confirmed' | 'rejected';

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;

  @ApiPropertyOptional()
  @IsOptional()
  // `enableImplicitConversion` is off, so a query param arrives as a string.
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  limit?: number;
}
