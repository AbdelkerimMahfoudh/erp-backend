import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { LoansService } from './loans.service';
import { CreateLoanDto, DecideLoanDto, ForgiveLoanDto, LoanPaymentDto } from './dto/loan.dto';

@ApiTags('loans')
@ApiBearerAuth()
@Controller({ version: '1' })
export class LoansController {
  constructor(private readonly loans: LoansService) {}

  @Get('loans')
  @RequirePermissions('loan.view')
  @ApiQuery({ name: 'group', required: false, enum: ['pending', 'accepted', 'confirmed'] })
  @ApiOperation({ summary: 'Money owed and lent, either direction' })
  list(@Query('group') group?: 'pending' | 'accepted' | 'confirmed') {
    return this.loans.list(group);
  }

  /**
   * What needs attention before the day is signed off.
   *
   * Gated on `loan.view` rather than `closing.perform`: it is loan data shown
   * ON the closing screen, not part of the closing itself, and it alters no
   * figure the closing computes.
   */
  @Get('loans/closing-reminders')
  @RequirePermissions('loan.view')
  @ApiOperation({ summary: 'Loan items awaiting action; affects no closing figure' })
  reminders() {
    return this.loans.closingReminders();
  }

  @Get('loans/:id')
  @RequirePermissions('loan.view')
  @ApiOperation({ summary: 'One loan, its balance and its whole history' })
  get(@Param('id') id: string) {
    return this.loans.get(id);
  }

  @Post('loans')
  @RequirePermissions('loan.manage')
  @ApiOperation({ summary: 'Propose a debt, in either direction' })
  propose(@Body() dto: CreateLoanDto) {
    return this.loans.propose(dto);
  }

  @Post('loans/:id/decide')
  @RequirePermissions('loan.manage')
  @ApiOperation({ summary: 'Accept, counter, dispute, reject or cancel a proposal' })
  decide(@Param('id') id: string, @Body() dto: DecideLoanDto) {
    return this.loans.decide(id, dto);
  }

  /**
   * Report, confirm or reverse a payment.
   *
   * Both keys are required at the route; the SERVICE decides which side may do
   * which, so holding both still does not let a debtor confirm their own
   * repayment. Who may confirm follows the DIRECTION, never who created the row.
   */
  @Post('loans/:id/payment')
  @RequirePermissions('loan.payment.report', 'loan.payment.confirm')
  @ApiOperation({ summary: 'Report a payment, confirm one arrived, or reverse one' })
  payment(@Param('id') id: string, @Body() dto: LoanPaymentDto) {
    return this.loans.payment(id, dto);
  }

  /** The creditor's Owner alone. Reduces what is owed and is never cash. */
  @Post('loans/:id/forgive')
  @RequirePermissions('loan.forgive')
  @ApiOperation({ summary: 'Write off part or all of a loan' })
  forgive(@Param('id') id: string, @Body() dto: ForgiveLoanDto) {
    return this.loans.forgive(id, dto);
  }
}
