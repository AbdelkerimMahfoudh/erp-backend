import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AgentProviderKind, AgentReferenceRule } from '@prisma/client';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';

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
 * A new configuration version (D164): since the commission is typed per exchange, the only thing a provider's
 * configuration still says is whether the provider issues a reference the counter must, may or need not enter.
 * There is no rate, no destination and no fee mode — the pipe refuses those fields. `effectiveFrom` is the server's
 * clock, not a field.
 */
export class CreateAgentProviderConfigDto {
  /** One key per change, reused on every retry: the same key and body answer with the first answer (D160). */
  @ApiProperty({ format: 'uuid', description: 'The client’s key for this change, kept across retries' })
  @IsUUID()
  clientRequestId: string;

  @ApiProperty({ enum: AgentReferenceRule, description: 'required: a reference for every exchange; optional: kept when given; none: never asked' })
  @IsEnum(AgentReferenceRule)
  referenceRule: AgentReferenceRule;

  /** Why this version exists — the schedule it was read from, the change it records. Kept forever. */
  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  reason: string;
}
