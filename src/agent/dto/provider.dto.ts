import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AgentCommissionDestination, AgentPrincipalFeeMode, AgentProviderKind, AgentReferenceRule } from '@prisma/client';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

/** A provider the company's agent counters exchange credit with (docs/73 §4.1). Company-wide; never deleted. */
export class CreateAgentProviderDto {
  /** One key per change, reused on every retry: the same key and body answer with the first answer (D160). */
  @ApiProperty({ format: 'uuid', description: 'The client’s key for this change, kept across retries' })
  @IsUUID()
  clientRequestId: string;

  @ApiProperty({ enum: AgentProviderKind })
  @IsEnum(AgentProviderKind)
  kind: AgentProviderKind;

  @ApiProperty({ maxLength: 80, example: 'Bankily' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  label: string;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateAgentProviderDto {
  /** One key per change, reused on every retry: the same key and body answer with the first answer (D160). */
  @ApiProperty({ format: 'uuid', description: 'The client’s key for this change, kept across retries' })
  @IsUUID()
  clientRequestId: string;

  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  label?: string;

  /** Switched off, a provider takes no new exchange; its float and its history stay. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

/**
 * A new configuration version (docs/73 §1.2, §4.2): the Owner fills each field
 * from the provider's real schedule. A field left null is a blank — the
 * provider cannot post while any required one is blank — never a zero.
 * `effectiveFrom` is the server's clock, not a field.
 */
export class CreateAgentProviderConfigDto {
  /** One key per change, reused on every retry: the same key and body answer with the first answer (D160). */
  @ApiProperty({ format: 'uuid', description: 'The client’s key for this change, kept across retries' })
  @IsUUID()
  clientRequestId: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 10_000, nullable: true, description: 'Basis points on Receive cash / Send credit; null = not supplied' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  rateInBp?: number | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 10_000, nullable: true, description: 'Basis points on Give cash / Receive credit; copied from rateInBp when the rate is the same both ways' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  rateOutBp?: number | null;

  @ApiProperty({ description: 'One rate for both directions: rateInBp is copied to rateOutBp' })
  @IsBoolean()
  sameRateBothDirections: boolean;

  @ApiPropertyOptional({ enum: AgentCommissionDestination, nullable: true })
  @IsOptional()
  @IsEnum(AgentCommissionDestination)
  commissionDestination?: AgentCommissionDestination | null;

  @ApiPropertyOptional({ enum: AgentPrincipalFeeMode, nullable: true })
  @IsOptional()
  @IsEnum(AgentPrincipalFeeMode)
  principalFeeMode?: AgentPrincipalFeeMode | null;

  @ApiPropertyOptional({ enum: AgentReferenceRule, nullable: true })
  @IsOptional()
  @IsEnum(AgentReferenceRule)
  referenceRule?: AgentReferenceRule | null;

  /** Why this version exists — the schedule it was read from, the change it records. Kept forever. */
  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  reason: string;
}
