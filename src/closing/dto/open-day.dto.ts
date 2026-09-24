import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

export class OpenDayDto {
  @ApiPropertyOptional({
    format: 'date',
    description: 'The business day being opened; defaults to, and must be, the branch’s current business date',
  })
  @IsOptional()
  @IsDateString()
  date?: string;
}
