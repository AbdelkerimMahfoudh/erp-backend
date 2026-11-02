import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { IsMoney } from '../../common/money/is-money.decorator';

export class RecordMaintenanceDto {
  @IsUUID() clientUuid!: string;
  @IsString() @MinLength(1) @MaxLength(200) description!: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @IsMoney({ min: 0 }) repairCost!: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @IsMoney({ min: 0 }) customerPaid!: number;
  @IsOptional() @IsIn(['cash', 'account']) paidMethod?: 'cash' | 'account';
  @IsOptional() @IsUUID() paidAccountId?: string;
  @IsOptional() @IsIn(['cash', 'account']) costMethod?: 'cash' | 'account';
  @IsOptional() @IsUUID() costAccountId?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) businessDate?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsBoolean() confirmZero?: boolean;
}

export class ReverseMaintenanceDto {
  @IsUUID() clientUuid!: string;
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}
