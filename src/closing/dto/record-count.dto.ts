import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { IsMoney } from '../../common/money/is-money.decorator';

/**
 * One channel's count, entered by whoever is holding the drawer (E-CP1).
 *
 * Deliberately one channel at a time. Counting cash and checking a Bankily
 * balance are separate acts that happen minutes apart, and forcing them into a
 * single submission means the first one is lost if the second is interrupted.
 */
export class RecordCountDto {
  @ApiProperty({ enum: ['cash', 'account'] })
  @IsIn(['cash', 'account'])
  channel: 'cash' | 'account';

  @ApiPropertyOptional({ format: 'uuid', description: 'Required when channel is `account`' })
  @IsOptional()
  @IsUUID()
  accountId?: string;

  /**
   * Zero is a real count and must stay distinguishable from "not counted yet",
   * which is why this is optional rather than defaulted.
   *
   * Cash is what the drawer holds, never below zero (checked in the service). An
   * account's figure is its NET movement for the day as the provider shows it —
   * received minus paid out — which can be negative (docs/51 §12.4).
   */
  @ApiPropertyOptional({ description: 'What was actually counted: the drawer for cash, the day’s net movement for an account' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsMoney()
  counted?: number;

  /**
   * An account balance cannot always be read at closing time. Skipping is
   * allowed, but it is recorded with a reason rather than inferred from a
   * missing count — silence and a decision must not look the same.
   */
  @ApiPropertyOptional({ description: 'Skip this channel instead of counting it' })
  @IsOptional()
  @IsBoolean()
  skip?: boolean;

  @ApiPropertyOptional({ maxLength: 255, description: 'Required when `skip` is true' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  skipReason?: string;

  @ApiPropertyOptional({ format: 'date', description: 'Day being counted; defaults to today (UTC)' })
  @IsOptional()
  @IsDateString()
  date?: string;
}
