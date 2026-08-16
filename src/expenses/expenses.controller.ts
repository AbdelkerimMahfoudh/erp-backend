import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { ExpensesService } from './expenses.service';
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
