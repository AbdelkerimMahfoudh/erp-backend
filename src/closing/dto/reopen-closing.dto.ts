import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional } from 'class-validator';

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
}
