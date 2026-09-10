import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { REPORT_LOCALES, type ReportLocale } from '../report-i18n';
import { MAX_DAYS, MIN_DAYS } from '../reports.service';

/**
 * Query parameters for an export, validated explicitly rather than coerced.
 *
 * `days` arrives as a string and the global pipe does not implicitly convert,
 * so the transform is what makes it a number at all — and `NaN` is turned into
 * a value the validator rejects, rather than one that silently becomes the
 * default. A typo in a period is a wrong report, and a wrong report that looks
 * right is the failure mode worth spending a transform on.
 */
export class ExportReportDto {
  @ApiPropertyOptional({ minimum: MIN_DAYS, maximum: MAX_DAYS, default: 30 })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  })
  @IsInt({ message: 'days must be a whole number of days' })
  @Min(MIN_DAYS)
  @Max(MAX_DAYS)
  days?: number;

  @ApiPropertyOptional({ enum: REPORT_LOCALES, default: 'en' })
  @IsOptional()
  @IsIn(REPORT_LOCALES as readonly string[], { message: 'locale must be en, fr or ar' })
  locale?: ReportLocale;
}
