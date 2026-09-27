import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * The amount a receiving account holds right now, as the Owner read it (docs/60).
 *
 * The moment is the server's clock, never typed: an anchor is only worth what
 * its instant is worth, because every movement after it is added on top.
 */
export class RecordMoneyAnchorDto {
  /** One key per attempt, reused on every retry: the same key and payload return the same anchor. */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  clientUuid: string;

  /** Any account of the company, active or not — a deactivated account's money is still somewhere. */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  accountId: string;

  /**
   * Zero or more, at most two decimals. Checked in the service rather than here,
   * so the refusal carries `amount_invalid` for the phone to act on.
   */
  @ApiProperty({ minimum: 0, description: 'What the account holds now, as its provider shows it' })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  amount: number;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}
