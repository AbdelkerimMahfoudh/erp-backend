import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { ClosingService } from './closing.service';
import { CreateClosingDto } from './dto/create-closing.dto';
import { RecordCountDto } from './dto/record-count.dto';
import { ReopenClosingDto } from './dto/reopen-closing.dto';
import { ResolveDiscrepancyDto } from './dto/resolve-discrepancy.dto';
import { CreateDebtEntryDto } from './dto/create-debt-entry.dto';
import { DiscrepanciesService } from './discrepancies.service';

@ApiTags('closing')
@ApiBearerAuth()
@Controller({ version: '1' })
export class ClosingController {
  constructor(
    private readonly closing: ClosingService,
    private readonly discrepancies: DiscrepanciesService,
  ) {}

  /**
   * The day as it stands, per channel (E-CP1).
   *
   * Gated on `closing.count`, not `closing.perform` — the Employee who has to
   * enter the count is the one who needs to see what is outstanding. It writes
   * nothing, so looking cannot commit anything.
   */
  @Get('closings/movements')
  @RequirePermissions('report.view')
  @ApiQuery({ name: 'from', required: true, description: 'First day, YYYY-MM-DD (inclusive)' })
  @ApiQuery({ name: 'to', required: true, description: 'Last day, YYYY-MM-DD (inclusive)' })
  @ApiOperation({ summary: 'Recorded money in and out per channel (cash and each account) for a period' })
  periodMovements(@Query('from') from: string, @Query('to') to: string) {
    return this.closing.periodMovements(from, to);
  }

  /**
   * The Money screen in one read (0074): cash in the drawer now, what moved
   * through each account today, the period's sales, collected and outstanding,
   * and today's expenses. `report.view`, like the figures it replaces.
   */
  @Get('closings/overview')
  @RequirePermissions('report.view')
  @ApiQuery({ name: 'from', required: true, description: 'First day, YYYY-MM-DD (inclusive)' })
  @ApiQuery({ name: 'to', required: true, description: 'Last day, YYYY-MM-DD (inclusive)' })
  @ApiOperation({ summary: 'Money overview: drawer now, accounts today, period sales, collected and outstanding' })
  overview(@Query('from') from: string, @Query('to') to: string) {
    return this.closing.overview(from, to);
  }

  /**
   * Which business day it is at this branch (0076): the date, its window, the
   * zone, whether the Owner may start the next date early, and how the
   * previous day stands. Anybody who can count may ask.
   */
  @Get('closings/business-day')
  @RequirePermissions('closing.count')
  @ApiOperation({ summary: 'The branch’s current business date, its window and the previous day’s standing' })
  businessDay() {
    return this.closing.businessDayView();
  }

  @Get('closings/open/view')
  @RequirePermissions('closing.count')
  @ApiQuery({ name: 'date', required: false, description: 'Business day to view; defaults to the current one' })
  @ApiOperation({ summary: 'The business day as it stands: channels, lifecycle, reopen choices and history' })
  openView(@Query('date') date?: string) {
    return this.closing.openView(date);
  }

  /**
   * Reopen the current business day after a counted close (0076), or — the
   * Owner alone, between midnight and 06:00 — start the next business date
   * now. Same authority as closing: the Owner and the two named delegates.
   */
  @Post('closings/reopen')
  @RequirePermissions('closing.perform')
  @ApiOperation({ summary: 'Reopen the current business day, or start the next one early (Owner)' })
  reopen(@Body() dto: ReopenClosingDto) {
    return this.closing.reopen(dto);
  }

  /**
   * Record one channel's count without locking anything.
   *
   * The E0 audit's first finding: counting and signing off were one act held by
   * one permission, so the person holding the drawer could not report what was
   * in it. These are now two acts and two permissions.
   */
  @Post('closings/count')
  @RequirePermissions('closing.count')
  @ApiOperation({ summary: 'Record one channel count; the day stays open and correctable' })
  recordCount(@Body() dto: RecordCountDto) {
    return this.closing.recordCount(dto);
  }

  @Post('closings')
  @RequirePermissions('closing.perform')
  @ApiOperation({ summary: 'Close the business day — or close it again after a reopen, with a fresh count' })
  close(@Body() dto: CreateClosingDto) {
    return this.closing.close(dto);
  }

  @Get('closings/:date')
  @RequirePermissions('closing.perform')
  @ApiOperation({ summary: 'Get a day closing (YYYY-MM-DD)' })
  getClosing(@Param('date') date: string) {
    return this.closing.getClosing(date);
  }

  /**
   * Differences still waiting on a decision (E-CP2).
   *
   * Visible to whoever signs days off, so a manager can see what is unresolved.
   * DECIDING one is a different, Owner-only authority — see `debt.manage`.
   */
  @Get('discrepancies')
  @RequirePermissions('closing.perform')
  @ApiOperation({ summary: 'Cash differences still under investigation' })
  listDiscrepancies() {
    return this.discrepancies.listPending();
  }

  @Get('discrepancies/:id')
  @RequirePermissions('closing.perform')
  @ApiOperation({ summary: 'One difference, with its ledger consequences' })
  getDiscrepancy(@Param('id') id: string) {
    return this.discrepancies.get(id);
  }

  /**
   * Owner only, and deliberately not `closing.perform` — a Manager holds that.
   * Deciding that a named person owes the business money is not an operational
   * act, and every decision carries a mandatory reason.
   */
  @Post('discrepancies/:id/resolve')
  @RequirePermissions('debt.manage')
  @ApiOperation({ summary: 'Decide a difference: absorb, correct, assign or forgive' })
  resolveDiscrepancy(@Param('id') id: string, @Body() dto: ResolveDiscrepancyDto) {
    return this.discrepancies.resolve(id, dto);
  }

  /**
   * What the signed-in person owes.
   *
   * Deliberately ungated: somebody being asked to repay money should never have
   * to ask permission to see the record of it. It reads only their own rows.
   */
  @Get('debt/me')
  @ApiOperation({ summary: 'What the signed-in person owes, and why' })
  myDebt() {
    return this.discrepancies.myLedger();
  }

  @Get('debt/:userId')
  @RequirePermissions('debt.manage')
  @ApiOperation({ summary: "One person's ledger and outstanding balance" })
  personDebt(@Param('userId') userId: string) {
    return this.discrepancies.ledgerFor(userId);
  }

  @Post('debt')
  @RequirePermissions('debt.manage')
  @ApiOperation({ summary: 'Record a repayment, a payroll deduction, or a write-off' })
  addDebtEntry(@Body() dto: CreateDebtEntryDto) {
    return this.discrepancies.addEntry(dto);
  }

  @Get('digests/:date')
  @RequirePermissions('report.view')
  @ApiOperation({ summary: 'Get a day digest with lines + historical comparison (YYYY-MM-DD)' })
  getDigest(@Param('date') date: string) {
    return this.closing.getDigest(date);
  }
}
