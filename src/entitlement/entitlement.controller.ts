import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { EntitlementService } from './entitlement.service';
import { RenewalReminderService } from './renewal-reminder.service';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../prisma/prisma.service';
import { uuidToBin } from '../common/utils/uuid.util';
import { BranchEntitlementService } from './branch-entitlement.service';

@ApiTags('entitlement')
@ApiBearerAuth()
@Controller({ version: '1' })
export class EntitlementController {
  constructor(
    private readonly entitlement: EntitlementService,
    private readonly reminders: RenewalReminderService,
    private readonly branches: BranchEntitlementService,
    private readonly cls: ClsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * What this company is entitled to.
   *
   * Deliberately ungated by permission: every role needs to know whether the
   * shop can still write, and a warning that only the Owner can see is a
   * warning the person at the counter discovers by being refused.
   *
   * It is also a GET, so it keeps working after expiry — the screen that
   * explains the lapse must not itself be blocked by the lapse.
   */
  @Get('entitlement')
  @ApiOperation({ summary: 'Subscription state, seats and whether writes are accepted' })
  async current() {
    const e = await this.entitlement.current();
    // 0132 (docs/122): each store's own state and dates. An Owner sees every store; anyone else only the stores they
    // work in — a locked store is never theirs, since it has no assignment until it opens.
    const companyId = this.cls.get<Buffer>('companyId');
    const userId = this.cls.get<string | undefined>('userId');
    const all = await this.branches.listForCompany(companyId);
    const mine = userId
      ? await this.prisma.userBranch.findMany({ where: { companyId, userId: uuidToBin(userId) }, select: { branchId: true, role: { select: { key: true } } } })
      : [];
    const owner = mine.some((m) => m.role.key === 'owner');
    const assigned = new Set(mine.map((m) => m.branchId.toString('hex')));
    const visible = owner ? all : all.filter((b) => assigned.has(b.branchId.replace(/-/g, '')));
    return { ...e, branches: visible };
  }

  /**
   * The Owner's 3/2/1-day renewal reminder, if one is due now (owner's brief, 2026-11-05): the days left, computed here,
   * and whether one of this Owner's devices showed it already. Any other role is refused (403 `owner_only`). A GET,
   * so it answers during the last days of access as it does before.
   */
  @Get('me/renewal-reminder')
  @ApiOperation({ summary: "The Owner's renewal reminder 3, 2 and 1 days before access ends, if due" })
  renewalReminder() {
    return this.reminders.current();
  }
}
