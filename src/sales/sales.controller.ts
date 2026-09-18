import { Body, Controller, Get, GoneException, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { SalesService } from './sales.service';
import { SalePaymentsService } from './sale-payments.service';
import { RecordSalePaymentDto } from './dto/record-payment.dto';
import { CreateSaleDto } from './dto/create-sale.dto';
import { ListSalesDto } from './dto/list-sales.dto';

@ApiTags('sales')
@ApiBearerAuth()
@Controller({ path: 'sales', version: '1' })
export class SalesController {
  constructor(
    private readonly sales: SalesService,
    private readonly payments: SalePaymentsService,
  ) {}

  /**
   * Both reads are gated on `sale.view` (I1). They previously required NO
   * permission at all, so any signed-in user could read the company's sales.
   * The permission is branch-scoped — it is absent from `COMPANY_PERMISSIONS` —
   * so a caller sending another branch's header, or no header, is refused
   * before the service runs.
   */
  @Get()
  @RequirePermissions('sale.view')
  @ApiOperation({
    summary: 'Sale history for the active branch — searched and paged in SQL',
    description:
      'Keyset paging on the UUIDv7 primary key. Every filter is applied in the database: a client that searched only the pages it had loaded would answer "not found" for a sale that exists.',
  })
  list(@Query() query: ListSalesDto) {
    return this.sales.list(query);
  }

  /**
   * Every balance still owed at this branch, grouped by who owes it (0074).
   *
   * `report.view`: the whole branch's receivables are an Owner and Manager
   * question. An Employee still sees a single sale's balance on its detail.
   * Declared before `:id`, which would otherwise swallow the path.
   */
  @Get('outstanding')
  @RequirePermissions('report.view')
  @ApiOperation({ summary: 'Balances still owed at this branch, grouped by customer or partner store' })
  outstanding() {
    return this.sales.outstanding();
  }

  /**
   * One line per day for a period: how many sales, their value, and what is
   * still owed on them (0074). A month of sales is read as thirty lines, and a
   * day's sales are fetched only when that day is opened.
   */
  @Get('by-day')
  @RequirePermissions('sale.view')
  @ApiQuery({ name: 'from', required: true, description: 'First day, YYYY-MM-DD (inclusive)' })
  @ApiQuery({ name: 'to', required: true, description: 'Last day, YYYY-MM-DD (inclusive)' })
  @ApiOperation({ summary: 'Sales per day for a period, with value and outstanding' })
  byDay(@Query('from') from: string, @Query('to') to: string) {
    return this.sales.byDay(from, to);
  }

  @Get(':id')
  @RequirePermissions('sale.view')
  @ApiOperation({
    summary: 'One sale in full — lines, identifiers, payments and its return policy',
    description:
      'Cost and margin are stripped for callers without cost.view by the global gating interceptor. Another company, another branch and an unknown id all answer the same 404.',
  })
  get(@Param('id') id: string) {
    return this.sales.getById(id);
  }

  @Post()
  @RequirePermissions('sale.create')
  @ApiOperation({ summary: 'Sell (one atomic transaction): units, profit, audit, notification' })
  create(@Body() dto: CreateSaleDto) {
    return this.sales.createSale(dto);
  }

  /**
   * Record money received later against a sale's balance (0074).
   *
   * `sale.create`, because whoever may take money at the counter may record
   * money that arrives afterwards. The server still decides everything:
   * the branch, the balance, the account, the day and the key.
   */
  @Post(':id/payments')
  @RequirePermissions('sale.create')
  @ApiOperation({
    summary: 'Record a later payment against a sale balance',
    description:
      'Not a second sale: revenue, cost and profit stay on the original sale. Refuses zero, negative and ' +
      'overpayment, an inactive account, a closed day, and a key reused for a different payment (409).',
  })
  recordPayment(@Param('id') id: string, @Body() dto: RecordSalePaymentDto) {
    return this.payments.record(id, dto);
  }

  /**
   * The legacy return endpoint — DISABLED (I1).
   *
   * What it used to do was unsafe in five separate ways: it trusted a
   * client-supplied `refundAmount` and never compared it to what was paid; it
   * rewrote the ORIGINAL sale's total, cost and margin in place; it ignored the
   * shop's return policy entirely; it restocked a defective phone as ordinary
   * sellable stock by default; and it had no request, review, idempotency or
   * concurrency protection. The audit is `docs/27`.
   *
   * It answers **410 Gone** rather than 404 so a stale client learns WHY it
   * stopped working instead of guessing at a bad URL. It is deliberately not
   * guarded on `sale.return` any more: a permission that gates nothing but a
   * refusal would imply the behaviour still exists somewhere.
   *
   * The service method and its DTO are deleted, not commented out — the
   * dangerous path must be unreachable, and Git keeps the history.
   */
  @Post(':id/returns')
  @HttpCode(HttpStatus.GONE)
  @ApiOperation({
    summary: 'DISABLED — the legacy return endpoint mutates nothing and returns 410',
    description:
      'Replaced by the Returns lifecycle (I2). This route performs no database write of any kind.',
  })
  legacyReturnDisabled() {
    throw new GoneException({
      code: 'legacy_return_disabled',
      message:
        'The legacy return endpoint has been disabled. Returns now require a reviewed request; nothing was changed.',
    });
  }
}
