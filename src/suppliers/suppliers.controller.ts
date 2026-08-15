import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { SuppliersService } from './suppliers.service';
import {
  ConfirmSettlementDto,
  CorrectSettlementDto,
  CreateSupplierDto,
  ListSuppliersDto,
  ReportSettlementDto,
  UpdateSupplierDto,
} from './dto/supplier.dto';

@ApiTags('suppliers')
@ApiBearerAuth()
@Controller({ path: 'suppliers', version: '1' })
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  /**
   * Deliberately open to any signed-in user: receiving has to pick a supplier,
   * and gating the list would gate stock intake. **The money is gated inside**
   * — the outstanding figure is omitted for anyone without `supplier.manage` or
   * `supplier.payment.confirm`, rather than the whole list being refused.
   */
  @Get()
  @ApiOperation({ summary: 'Browse suppliers. Financial figures are omitted unless permitted.' })
  list(@Query() query: ListSuppliersDto) {
    return this.suppliers.list(query);
  }

  /**
   * Declared BEFORE `:id`, or Nest matches "payments" as a supplier id — the
   * same ordering trap the transfers controller documents.
   */
  @Post('payments')
  @RequirePermissions('supplier.payment.report')
  @ApiOperation({
    summary: 'Report that a supplier was paid — a claim, not the record',
    description:
      'Creates no cash movement and settles nothing until confirmed. The allocation across purchases is explicit and is returned.',
  })
  report(@Body() dto: ReportSettlementDto) {
    return this.suppliers.report(dto);
  }

  @Get('payments/:settlementId')
  @RequirePermissions('supplier.payment.report')
  @ApiOperation({ summary: 'One payment, reported or confirmed' })
  settlement(@Param('settlementId') id: string) {
    return this.suppliers.settlement(id);
  }

  @Patch('payments/:settlementId')
  @RequirePermissions('supplier.payment.confirm')
  @ApiOperation({
    summary: 'Correct how a reported payment was made, before confirming it',
    description: 'Method, account, reference, note and allocation. The amount is never correctable.',
  })
  correct(@Param('settlementId') id: string, @Body() dto: CorrectSettlementDto) {
    return this.suppliers.correct(id, dto);
  }

  @Post('payments/:settlementId/confirm')
  @RequirePermissions('supplier.payment.confirm')
  @ApiOperation({
    summary: 'Confirm the payment — this is the authoritative record',
    description:
      'Settles the liability exactly once and books the cash movement on the confirmation day. No profit effect.',
  })
  confirm(@Param('settlementId') id: string, @Body() dto: ConfirmSettlementDto) {
    return this.suppliers.confirm(id, dto);
  }

  @Post()
  @RequirePermissions('supplier.manage')
  @ApiOperation({ summary: 'Add a supplier' })
  create(@Body() dto: CreateSupplierDto) {
    return this.suppliers.create(dto);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One supplier. The payable ledger is included only if permitted.',
  })
  detail(@Param('id') id: string) {
    return this.suppliers.detail(id);
  }

  /** What is still owed, oldest first, with a suggested split of an amount. */
  @Get(':id/payable')
  @RequirePermissions('supplier.payment.report')
  @ApiOperation({ summary: 'Open purchases and a suggested oldest-first allocation' })
  payable(@Param('id') id: string, @Query('amount') amount?: string) {
    return this.suppliers.payableFor(id, amount ? Number(amount) : undefined);
  }

  @Patch(':id')
  @RequirePermissions('supplier.manage')
  @ApiOperation({
    summary: 'Edit a supplier, or deactivate/reactivate it',
    description: 'There is no delete. Deactivation hides it from new receiving and keeps all history.',
  })
  update(@Param('id') id: string, @Body() dto: UpdateSupplierDto) {
    return this.suppliers.update(id, dto);
  }
}
