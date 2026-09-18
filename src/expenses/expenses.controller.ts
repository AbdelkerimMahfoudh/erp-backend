import { Body, Controller, Get, Param, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { ExpensesService } from './expenses.service';
import { MAX_RECEIPT_BYTES } from './receipt-rules';
import { CreateExpenseDto, DecideExpenseDto, ListExpensesDto } from './dto/create-expense.dto';

/**
 * Expenses, with the authority split the D0 audit said the model could not
 * previously express.
 *
 * `seed-data/permissions.ts` used to note: *"expense.manage — the model cannot
 * express 'submit' separately from 'manage', so the narrower reading wins."*
 * It can now, so it does:
 *
 *   `expense.submit`  Owner, Store Manager, Store Employee — report what you
 *                     spent. **Does not reveal anybody else's expenses**: the
 *                     list scopes a submitter to their own.
 *   `expense.review`  **Owner only** — confirm or reject. Confirming is the
 *                     moment money is treated as having left the business.
 *   `expense.manage`  **Owner only**, unchanged — categories, templates and
 *                     settings. Deliberately NOT widened.
 */
@ApiTags('expenses')
@ApiBearerAuth()
@Controller({ path: 'expenses', version: '1' })
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  @RequirePermissions('expense.submit')
  @ApiOperation({
    summary: 'Expenses at the active branch',
    description:
      'A reviewer or manager sees every expense. Anybody else sees only the ones they reported — submitting must not hand somebody the shop’s whole outgoings.',
  })
  list(@Query() query: ListExpensesDto) {
    return this.expenses.list(query);
  }

  @Post()
  @RequirePermissions('expense.submit')
  @ApiOperation({
    summary: 'Report an expense',
    description:
      'Records a claim and nothing else. No cash, account, profit or report figure changes until an owner confirms it.',
  })
  create(@Body() dto: CreateExpenseDto) {
    return this.expenses.create(dto);
  }

  @Get(':id')
  @RequirePermissions('expense.submit')
  @ApiOperation({ summary: 'One expense' })
  detail(@Param('id') id: string) {
    return this.expenses.detail(id);
  }

  /**
   * Attach a photo of the receipt (0074). Optional evidence: it changes no
   * amount, status or day. The image type is read from the file's own bytes.
   */
  @Post(':id/receipt')
  @RequirePermissions('expense.submit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RECEIPT_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Attach a receipt photo to an expense' })
  attachReceipt(@Param('id') id: string, @UploadedFile() file: { buffer: Buffer } | undefined) {
    return this.expenses.attachReceipt(id, file?.buffer);
  }

  /**
   * The receipt photo, as the raw image.
   *
   * Written straight to the response, the way the report export does it. A
   * returned `StreamableFile` passed through the global response interceptors
   * and reached the client as a JSON description of a stream, labelled as a
   * JPEG — found by the live lifecycle check, not by the suite.
   */
  @Get(':id/receipt')
  @RequirePermissions('expense.submit')
  @ApiOperation({ summary: 'The receipt photo, for whoever may read the expense' })
  async receipt(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const { bytes, contentType } = await this.expenses.readReceipt(id);
    res.setHeader('Content-Type', contentType);
    // Private evidence: never kept by a shared cache.
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(bytes);
  }

  @Post(':id/confirm')
  @RequirePermissions('expense.review')
  @ApiOperation({
    summary: 'Confirm — the moment the money counts as spent',
    description:
      'A VARIABLE expense lands on today, which must be open; a FIXED one lands on its own due date. Refused with 409 if a variable expense would land on a closed day: a filed closing is never reopened.',
  })
  confirm(@Param('id') id: string, @Body() dto: DecideExpenseDto) {
    return this.expenses.confirm(id, dto);
  }

  @Post(':id/reject')
  @RequirePermissions('expense.review')
  @ApiOperation({ summary: 'Reject. Nothing financial ever included it.' })
  reject(@Param('id') id: string, @Body() dto: DecideExpenseDto) {
    return this.expenses.reject(id, dto);
  }
}
