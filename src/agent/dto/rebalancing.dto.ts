import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AgentExternalCounterparty } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsEnum, IsIn, IsNumber, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { IsMoney } from '../../common/money/is-money.decorator';

/** One leg of a rebalancing, over the branch's own accounts (docs/73 §4.3). */
export class AgentRebalancingLegDto {
  @ApiProperty({ enum: ['cash', 'provider', 'commission_held'] })
  @IsIn(['cash', 'provider', 'commission_held'])
  account: 'cash' | 'provider' | 'commission_held';

  @ApiPropertyOptional({ format: 'uuid', description: 'Required for a float or a held commission; absent for the drawer' })
  @IsOptional()
  @IsUUID()
  providerId?: string;

  @ApiProperty({ enum: ['inflow', 'outflow'] })
  @IsIn(['inflow', 'outflow'])
  direction: 'inflow' | 'outflow';

  @ApiProperty({ minimum: 0.01 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsMoney({ min: 0.01 })
  amount: number;
}

/**
 * Money moved between the drawer and the floats, or brought in from / sent out
 * to the outside (A8): never a customer exchange — no count, no volume, no
 * commission. The legs net to zero unless an outside party is named for
 * exactly the difference.
 */
export class CreateAgentRebalancingDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  clientUuid: string;

  @ApiProperty({ maxLength: 255, example: 'Bought Bankily float with cash' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  reason: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiProperty({ type: [AgentRebalancingLegDto], minItems: 1 })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AgentRebalancingLegDto)
  legs: AgentRebalancingLegDto[];

  @ApiPropertyOptional({ enum: AgentExternalCounterparty })
  @IsOptional()
  @IsEnum(AgentExternalCounterparty)
  externalCounterparty?: AgentExternalCounterparty;

  /** Signed: positive when money came in from outside, negative when it went out. */
  @ApiPropertyOptional({ description: 'Exactly the difference between the legs in and out' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsMoney()
  externalAmount?: number;

  /** The Owner's confirmation that cash or a float may go below zero (docs/73 §4.7 row 4); ignored for anybody else. */
  @ApiPropertyOptional({ description: 'Owner only: record it although a known position would go below zero' })
  @IsOptional()
  @IsBoolean()
  confirmNegative?: boolean;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ListAgentRebalancingsDto {
  @ApiPropertyOptional({ example: '2026-10-01', description: 'First business date, inclusive; defaults to the current one' })
  @IsOptional()
  @Matches(DATE)
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-08', description: 'Last business date, inclusive; defaults to `from`' })
  @IsOptional()
  @Matches(DATE)
  to?: string;
}
