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
  MinLength,
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

export class ReportSoldDto {
  /**
   * Which phones sold. Omitted means all of them still in custody — a
   * single-phone consignment should not require listing its own line.
   */
  @ApiPropertyOptional({ type: [String], format: 'uuid' })
  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  lineIds?: string[];
}

export class ConsignmentPaymentDto {
  @ApiProperty({ enum: ['report', 'confirm'] })
  @IsIn(['report', 'confirm'])
  action: 'report' | 'confirm';

  @ApiPropertyOptional({ minimum: 0.01, description: 'Required when reporting' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount?: number;

  @ApiPropertyOptional({ enum: ['cash', 'account'] })
  @IsOptional()
  @IsIn(['cash', 'account'])
  method?: 'cash' | 'account';

  @ApiPropertyOptional({ format: 'uuid', description: 'Required when the method is account' })
  @IsOptional()
  @IsUUID()
  receivingAccountId?: string;

  /**
   * A note the two shops can compare. **Not proof** — no provider is contacted
   * and nothing is verified, and the screens must never present it as
   * confirmation.
   */
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;

  @ApiPropertyOptional({ maxLength: 512, description: 'A photo reference; still not proof' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  evidenceRef?: string;

  /** Which reported payment is being confirmed. */
  @ApiPropertyOptional({ format: 'uuid', description: 'Required when confirming' })
  @IsOptional()
  @IsUUID()
  entryId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Idempotency key for an offline retry' })
  @IsOptional()
  @IsUUID()
  clientUuid?: string;
}

export class ForgiveDto {
  @ApiProperty({ minimum: 0.01 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;

  /**
   * Mandatory. A write-off nobody can explain is indistinguishable from money
   * quietly going missing.
   */
  @ApiProperty({ minLength: 3, maxLength: 255 })
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  reason: string;
}

export class ReturnDto {
  @ApiProperty({ enum: ['initiate', 'ship', 'confirm'] })
  @IsIn(['initiate', 'ship', 'confirm'])
  action: 'initiate' | 'ship' | 'confirm';

  /**
   * Required when confirming receipt. A damaged phone routes to `faulty`, never
   * straight back to sellable — automatically restocking something that came
   * back broken is how a shop sells a fault it already knew about.
   */
  @ApiPropertyOptional({ enum: ['good', 'damaged'] })
  @IsOptional()
  @IsIn(['good', 'damaged'])
  condition?: 'good' | 'damaged';

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}
