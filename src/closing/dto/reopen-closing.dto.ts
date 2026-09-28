import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsOptional, ValidateNested } from 'class-validator';
import { OpeningMoneyDto } from './opening-money.dto';

export class ReopenClosingDto {
  @ApiPropertyOptional({
    format: 'date',
    description: 'The business day to reopen; defaults to the branch’s current business date',
  })
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiPropertyOptional({
    enum: ['continue', 'start_new'],
    default: 'continue',
    description:
      '`continue` adds new sales to the reopened day (the safe default). `start_new` starts the next ' +
      'business date now, before 06:00 — the Owner alone, and only after local midnight.',
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
