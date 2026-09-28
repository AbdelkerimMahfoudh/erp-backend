import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsOptional, ValidateNested } from 'class-validator';
import { OpeningMoneyDto } from './opening-money.dto';

export class OpenDayDto {
  @ApiPropertyOptional({
    format: 'date',
    description: 'The business day being opened; defaults to, and must be, the branch’s current business date',
  })
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiPropertyOptional({
    enum: ['continue', 'start_new'],
    default: 'continue',
    description:
      'Before 06:00 the business date is still the previous calendar day. `continue` opens that day (the safe ' +
      'default); `start_new` starts the next business date now and opens it — the Owner alone, after local midnight. ' +
      'Nothing already recorded moves.',
  })
  @IsOptional()
  @IsIn(['continue', 'start_new'])
  mode?: 'continue' | 'start_new';

  /** The money the shop opens with (docs/63): required from the Owner, never from anybody else. */
  @ApiPropertyOptional({ type: OpeningMoneyDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OpeningMoneyDto)
  openingMoney?: OpeningMoneyDto;
}
