import { Controller, Get, Header, Param, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { ReportsService } from './reports.service';
import { ExportReportDto } from './dto/export-report.dto';
import { isReportKind, REPORT_KINDS } from './report-catalogue';
import { BadRequestException } from '@nestjs/common';

/**
 * `GET /api/v1/reports/:kind.csv` — one report, as a spreadsheet.
 *
 * ## Why the response is written by hand
 *
 * Returning a string would send it through the global interceptor stack, which
 * is built for JSON: `BinaryUuidInterceptor` and `CostGatingInterceptor` map
 * over the value, and a serializer would quote the whole file. Writing to the
 * `Response` directly bypasses everything after the controller — which is
 * exactly the point, and exactly the risk.
 *
 * **So authorization does not live downstream.** `ReportsService` decides which
 * columns this caller may receive BEFORE any bytes exist. Nest's own
 * documentation on streaming files notes that a directly-piped response skips
 * post-controller interceptors; this module is written on the assumption that
 * nothing after it will help.
 *
 * ## Errors are still ordinary errors
 *
 * A refusal throws, and Nest's exception filter answers with the project's
 * normal JSON error shape and status. A CSV that contains an error message is a
 * file a spreadsheet opens happily and a person misreads as data.
 */
@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /**
   * Gated on `report.view` like every other reporting route. Reports needing
   * more than that declare it in the catalogue and the service checks it on
   * every request — not once at startup, and not from a role name.
   */
  @Get(':kind.csv')
  @RequirePermissions('report.view')
  @ApiOperation({ summary: 'One report as a CSV spreadsheet' })
  @ApiParam({ name: 'kind', enum: REPORT_KINDS })
  @ApiQuery({ name: 'days', required: false, description: 'Period reports only; 1–366, default 30' })
  @ApiQuery({ name: 'locale', required: false, enum: ['en', 'fr', 'ar'] })
  @Header('Cache-Control', 'private, no-store')
  async exportCsv(
    @Param('kind') kind: string,
    @Query() query: ExportReportDto,
    @Res() res: Response,
  ): Promise<void> {
    if (!isReportKind(kind)) {
      throw new BadRequestException(
        `Unknown report "${kind}". Available: ${REPORT_KINDS.join(', ')}.`,
      );
    }

    const result = await this.reports.export({
      kind,
      locale: query.locale ?? 'en',
      days: query.days,
    });

    /*
      The filename is built from the report kind and a date — ASCII, no user
      text, nothing to escape. It is still quoted, because a header value is a
      header value and the day somebody makes a filename translatable is the day
      an unquoted one breaks.
    */
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    // The row count, so a client can show "1 240 rows" without parsing the file.
    res.setHeader('X-Report-Rows', String(result.rowCount));
    res.send(result.csv);
  }
}
