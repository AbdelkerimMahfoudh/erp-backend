import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateConsignmentDto {
  @ApiProperty({ format: 'uuid', description: 'Who the phones are going to' })
  @IsUUID()
  counterpartyId: string;

  /**
   * One serialized unit per line, several lines per consignment. Capped because
   * each one takes a compare-and-swap, and a request for a thousand phones is a
   * mistake rather than a deal.
   */
  @ApiProperty({ type: [String], format: 'uuid', maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID(undefined, { each: true })
  unitIds: string[];

  @ApiProperty({ minimum: 0.01, description: 'What you are asking, in total' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  proposedAmount: number;

  @ApiPropertyOptional({ maxLength: 255, description: 'Condition as sent' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  conditionNote?: string;

  /**
   * Faults the sender is disclosing. Recorded explicitly so "I was not told" is
   * answerable from the record rather than from two people's memories.
   */
  @ApiPropertyOptional({ maxLength: 255, description: 'Any fault you are disclosing' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  defectNote?: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Idempotency key for an offline retry' })
  @IsOptional()
  @IsUUID()
  clientUuid?: string;
}

export class DecideConsignmentDto {
  @ApiProperty({ enum: ['accept', 'counter', 'dispute', 'reject', 'cancel'] })
  @IsIn(['accept', 'counter', 'dispute', 'reject', 'cancel'])
  action: 'accept' | 'counter' | 'dispute' | 'reject' | 'cancel';

  @ApiPropertyOptional({ minimum: 0.01, description: 'Required for a counter-offer' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount?: number;

  /** Mandatory for a dispute: "rejected" with no reason is not a conversation. */
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

export class CustodyDto {
  @ApiProperty({ enum: ['send', 'confirm'] })
  @IsIn(['send', 'confirm'])
  action: 'send' | 'confirm';

  /**
   * What the receiver physically scanned. A mismatch is refused with both
   * values rather than silently adopting the scan — otherwise the owner would
   * discover months later that the phone they are owed for is not the one they
   * sent.
   */
  @ApiPropertyOptional({ type: [String], description: 'Identifiers scanned on receipt' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  identifiers?: string[];
}
