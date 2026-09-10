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
  Min,
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
   */
  @ApiPropertyOptional({ minimum: 0, description: 'What was actually counted' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsMoney({ min: 0 })
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
