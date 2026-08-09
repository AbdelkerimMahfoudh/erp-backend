import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min } from 'class-validator';

export class CreateTransferDto {
  /**
   * Client-generated request id, **required** (H1.1).
   *
   * Without it a retried Send moves stock twice, which the H0 audit proved was
   * possible. The client makes one id per attempt and reuses it for every retry
   * of that same attempt, exactly as Sell and Purchase already do.
   */
  @ApiProperty({ format: 'uuid', description: 'One id per transfer attempt; reuse it when retrying.' })
  @IsUUID()
  clientUuid: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  toBranchId: string;

  @ApiProperty({ type: [String], description: 'Unit identifiers (IMEI or serial)', example: ['123456789012347'] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  identifiers: string[];
}

export class ReceiveTransferDto {
  @ApiProperty({ type: [String], description: 'Scanned identifiers at the destination (may be empty)' })
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  identifiers: string[];
}

/** The six lifecycle states, as the history filter offers them. */
export const TRANSFER_STATUSES = [
  'pending_approval',
  'approved',
  'in_transit',
  'received',
  'rejected',
  'cancelled',
] as const;

export class ListTransfersDto {
  /**
   * One or more statuses, comma-separated. Absent means every status — the
   * history screen needs completed and refused transfers to stay reachable.
   */
  @ApiPropertyOptional({ example: 'pending_approval,approved' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  status?: string;

  /**
   * Free text across the transfer reference, both branch names, the product and
   * the IMEI/serial. Matched in SQL, never in the app: a client that filters
   * only the pages it happens to have loaded answers "not found" for something
   * that exists.
   */
  @ApiPropertyOptional({ example: '356938035643809' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;

  /** Opaque keyset cursor from the previous page. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}

export class SetTransferPrefixDto {
  @ApiProperty({ example: 'NKC', maxLength: 8, description: 'Uppercase alphanumeric; empty clears it' })
  @IsString()
  @MaxLength(8)
  @Matches(/^[A-Z0-9]{0,8}$/, { message: 'prefix must be up to 8 uppercase letters/digits' })
  prefix: string;
}

/**
 * Every lifecycle transition carries the version the caller last saw.
 *
 * Without it, two managers acting on one request would both succeed and the
 * second would silently overwrite the first's decision. `expectedVersion` makes
 * the database arbitrate: the loser matches no row and is told to refresh.
 */
export class TransferDecisionDto {
  @ApiProperty({ minimum: 0, description: 'Version of the transfer as you last read it.' })
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  /** Mandatory for reject and cancel; ignored elsewhere. */
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
