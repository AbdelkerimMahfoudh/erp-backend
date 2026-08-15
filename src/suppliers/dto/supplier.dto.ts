import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateSupplierDto {
  @ApiProperty({ maxLength: 160 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(40)
  phone?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateSupplierDto {
  @ApiPropertyOptional({ maxLength: 160 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;

  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(40)
  phone?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  notes?: string;

  /**
   * Deactivate or reactivate. **Never a delete** — a supplier the shop has
   * bought from is part of its financial history, and history is not editable.
   */
  @ApiPropertyOptional({ description: 'false hides it from new receiving; history is untouched' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ListSuppliersDto {
  @ApiPropertyOptional({ description: 'Matches name or phone' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  search?: string;

  @ApiPropertyOptional({ enum: ['active', 'inactive', 'all'], default: 'active' })
  @IsOptional()
  @IsEnum({ active: 'active', inactive: 'inactive', all: 'all' })
  status?: 'active' | 'inactive' | 'all';

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cursor?: string;

  /**
   * A query parameter arrives as a STRING and the global pipe does not
   * implicitly convert, so the transform is what makes this usable at all —
   * the same trap `?limit=` fell into for transfers.
   */
  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

/** One purchase this payment pays down, and by how much. */
export class SettlementAllocationDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  purchaseId!: string;

  @ApiProperty({ minimum: 0.01 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;
}

export class ReportSettlementDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  supplierId!: string;

  @ApiProperty({ minimum: 0.01, description: 'Total handed over. Must equal the allocations.' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @ApiProperty({ enum: ['cash', 'account'] })
  @IsEnum({ cash: 'cash', account: 'account' })
  method!: 'cash' | 'account';

  /** Required for `account`, forbidden for `cash` — the database enforces both. */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  receivingAccountId?: string;

  /**
   * Explicit, always. When the app offers oldest-first it fills this in and
   * shows the result first — money is never spread by a server nobody asked.
   */
  @ApiProperty({ type: [SettlementAllocationDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SettlementAllocationDto)
  allocations!: SettlementAllocationDto[];

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  transactionReference?: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  note?: string;

  /** Mandatory. An offline retry must not record two payments. */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  clientUuid!: string;
}

export class CorrectSettlementDto {
  @ApiProperty({ description: 'The version last seen. Two managers, one winner.' })
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ApiPropertyOptional({ enum: ['cash', 'account'] })
  @IsOptional()
  @IsEnum({ cash: 'cash', account: 'account' })
  method?: 'cash' | 'account';

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  receivingAccountId?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  transactionReference?: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  note?: string;

  /**
   * Re-allocation, within the same total. The amount is not correctable here:
   * a different amount is a different payment, not a correction of this one.
   */
  @ApiPropertyOptional({ type: [SettlementAllocationDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SettlementAllocationDto)
  allocations?: SettlementAllocationDto[];
}

export class ConfirmSettlementDto {
  @ApiProperty()
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}
