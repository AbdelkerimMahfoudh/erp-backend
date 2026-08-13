import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** The most one request may move, so a typo cannot promise the whole shop. */
export const MAX_LINE_QUANTITY = 100_000;

/**
 * A serialized line: one specific phone, named by the number printed on it.
 *
 * There is no quantity here at all. One IMEI is one object, and offering a
 * quantity beside it would invite "5 × this exact phone", which is not a thing
 * that can exist.
 */
export class TransferUnitLineDto {
  @ApiProperty({ enum: ['unit'] })
  @IsIn(['unit'])
  kind!: 'unit';

  @ApiProperty({ maxLength: 64, example: '356938035643809', description: 'IMEI or serial number' })
  @IsString()
  @MaxLength(64)
  identifier!: string;
}

/**
 * A quantity line: some of what a branch holds of one accessory.
 *
 * The source stock row is not named directly. `stock_items` is UNIQUE on
 * `(company, product, branch)` and the transfer already knows its own source
 * branch, so the product identifies exactly one row — and a second id in the
 * request would be a second source of truth a client could get wrong.
 */
export class TransferStockLineDto {
  @ApiProperty({ enum: ['stock'] })
  @IsIn(['stock'])
  kind!: 'stock';

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  productId!: string;

  @ApiProperty({ minimum: 1, maximum: MAX_LINE_QUANTITY, example: 10 })
  @IsInt()
  @Min(1)
  @Max(MAX_LINE_QUANTITY)
  quantity!: number;
}

export type TransferLineDto = TransferUnitLineDto | TransferStockLineDto;

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

  /**
   * What is being moved, one line per thing (H1.4).
   *
   * Discriminated on `kind` rather than inferred from which optional fields
   * happen to be present: "a productId and no identifier" is a shape a client
   * can arrive at by accident, and guessing what they meant is how a request
   * moves something nobody asked for.
   */
  @ApiPropertyOptional({
    type: 'array',
    items: {
      oneOf: [
        { $ref: '#/components/schemas/TransferUnitLineDto' },
        { $ref: '#/components/schemas/TransferStockLineDto' },
      ],
    },
    description: 'Mixed serialized and quantity lines. Preferred over `identifiers`.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => Object, {
    discriminator: {
      property: 'kind',
      subTypes: [
        { value: TransferUnitLineDto, name: 'unit' },
        { value: TransferStockLineDto, name: 'stock' },
      ],
    },
    keepDiscriminatorProperty: true,
  })
  lines?: TransferLineDto[];

  /**
   * The serialized-only shape H1.1–H1.3 shipped.
   *
   * Kept accepted so a client built against the old contract keeps working
   * while the app moves to `lines`; it is exactly equivalent to a `lines` array
   * of `unit` entries. **Remove it once no client sends it** — two ways to say
   * the same thing is a contract that will eventually disagree with itself.
   */
  @ApiPropertyOptional({ type: [String], description: 'Deprecated: use `lines`.', example: ['123456789012347'] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  identifiers?: string[];
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

  /**
   * A query parameter arrives as a STRING, and the global pipe runs with
   * `enableImplicitConversion: false`, so `@IsInt()` alone rejects every value
   * a client could actually send — `?limit=3` was a 400 until a live request
   * proved it. The explicit transform is what makes the parameter usable, and
   * matches how the catalog does it.
   */
  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(50)
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
