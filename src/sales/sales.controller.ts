import { Body, Controller, Get, GoneException, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { SalesService } from './sales.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import { ListSalesDto } from './dto/list-sales.dto';

@ApiTags('sales')
@ApiBearerAuth()
@Controller({ path: 'sales', version: '1' })
export class SalesController {
  constructor(private readonly sales: SalesService) {}

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
