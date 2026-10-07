import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PAYER_NUMBER_MAX_INPUT } from '../payer-number';

/**
 * Correcting the number a payment came from (D151). It moves no money, so it is
 * a correction of record, not of accounts: the amount, method, account and day
 * stay exactly as they were.
 */
export class CorrectPayerNumberDto {
  @ApiPropertyOptional({
    nullable: true,
    maxLength: PAYER_NUMBER_MAX_INPUT,
    description: 'The corrected number (digits, spaces, hyphens, an optional leading +); blank or null removes it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(PAYER_NUMBER_MAX_INPUT)
  payerNumber?: string | null;

  @ApiPropertyOptional({ maxLength: 255, description: 'Why it was corrected, for the audit history.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}
