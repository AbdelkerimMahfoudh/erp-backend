import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * What a provider float — or the commission a provider holds — holds right
 * now at this branch, as the Owner read it (docs/73 §4.4). The moment is the
 * server's clock, never typed: every leg after it is added on top.
 */
export class SetAgentPositionDto {
  /** One key per attempt, reused on every retry: the same key and payload return the same record. */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  clientUuid: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  providerId: string;

  @ApiPropertyOptional({ enum: ['provider', 'commission_held'], default: 'provider' })
  @IsOptional()
  @IsIn(['provider', 'commission_held'])
  accountKind?: 'provider' | 'commission_held';

  /** Zero or more, at most two decimals — checked in the service so the refusal carries `amount_invalid`. */
  @ApiProperty({ minimum: 0, description: 'What the float holds now, as the provider’s app shows it' })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  amount: number;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}
