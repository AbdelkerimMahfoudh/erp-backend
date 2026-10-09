import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AgentDirection, AgentTransactionStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { IsMoney } from '../../common/money/is-money.decorator';
import { PAYER_NUMBER_MAX_INPUT } from '../../sales/payer-number';

/**
 * One exchange at the counter (A5–A6, docs/73 §4.1). What the server derives
 * is not here: the person recording it comes from the session (the global pipe
 * refuses any `employeeId`, `userId` or `recordedBy` a body might carry), the
 * commission from the provider's configuration, the instant and the business
 * day from the server's clock.
 */
export class CreateAgentTransactionDto {
  @ApiProperty({ format: 'uuid', description: 'The phone’s key for this exchange, kept across retries' })
  @IsUUID()
  clientUuid: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  providerId: string;

  @ApiProperty({ enum: AgentDirection, description: 'cash_in_credit_out: Receive cash / Send credit. cash_out_credit_in: Give cash / Receive credit.' })
  @IsEnum(AgentDirection)
  direction: AgentDirection;

  @ApiProperty({ minimum: 0.01 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @IsMoney({ min: 0.01 })
  amount: number;

  /** Mandatory, apart from the provider's reference; normalised by the server (`agent-rules.ts`). */
  @ApiProperty({ maxLength: PAYER_NUMBER_MAX_INPUT, description: 'The customer’s number: digits, spaces, hyphens, an optional leading +' })
  @IsString()
  @MinLength(1)
  @MaxLength(PAYER_NUMBER_MAX_INPUT)
  customerNumber: string;

  @ApiPropertyOptional({ maxLength: 120, description: 'The provider’s own reference, as its rule requires' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  providerReference?: string;

  /** The configuration version the phone showed: a different one in force is refused as stale (D155). */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  configVersionId?: string;

  /** What the phone's clock said when the exchange was recorded — a claim, kept beside the server's instant. */
  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601()
  deviceRecordedAt?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Filters for the branch's exchange history. Every one is applied in SQL; the list is always masked. */
export class ListAgentTransactionsDto {
  @ApiPropertyOptional({ example: '2026-10-01', description: 'First business date, inclusive' })
  @IsOptional()
  @Matches(DATE)
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-08', description: 'Last business date, inclusive' })
  @IsOptional()
  @Matches(DATE)
  to?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  providerId?: string;

  @ApiPropertyOptional({ enum: AgentDirection })
  @IsOptional()
  @IsEnum(AgentDirection)
  direction?: AgentDirection;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  recordedById?: string;

  /** The masked search: the last four digits of the customer number, never more. */
  @ApiPropertyOptional({ example: '3456' })
  @IsOptional()
  @Matches(/^\d{4}$/)
  last4?: string;

  @ApiPropertyOptional({ maxLength: 120, description: 'An exact provider reference' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;

  @ApiPropertyOptional({ enum: AgentTransactionStatus })
  @IsOptional()
  @IsEnum(AgentTransactionStatus)
  status?: AgentTransactionStatus;

  /** Opaque keyset cursor from the previous page. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cursor?: string;

  /** A query parameter is a string and the global pipe does not convert, so the number is read explicitly (as the sales list does). */
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** The Owner's or a Manager's reversal (A7): once, audited, with a reason that stays. */
export class ReverseAgentTransactionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  clientUuid: string;

  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  reason: string;
}
