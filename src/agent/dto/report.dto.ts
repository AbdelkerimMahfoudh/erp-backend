import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { REPORT_PERIODS, type ReportPeriod } from '../agent-report-rules';

/** A day, a week, a month or a year of the counter, around a business date (D157). */
export class AgentReportQueryDto {
  @ApiProperty({ enum: REPORT_PERIODS })
  @IsIn(REPORT_PERIODS)
  period: ReportPeriod;

  @ApiPropertyOptional({ example: '2026-10-08', description: 'A business date inside the period; defaults to the current one' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;
}
