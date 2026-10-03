import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContext } from '../tenant/tenant-context.service';
import {
  businessDateOf,
  dayWindow,
  isBeforeDayStart,
  isValidTimezone,
  localDateOf,
  shiftDate,
  type DayWindow,
} from '../business-day';

/** The DATE column value for a YYYY-MM-DD, the way every existing reader builds it. */
export const dateValue = (date: string): Date => new Date(`${date}T00:00:00.000Z`);
/** The YYYY-MM-DD of a DATE column value. */
export const dateKey = (value: Date): string => value.toISOString().slice(0, 10);

/** Any client that can read the two facts the assignment needs: the company's timezone and an early start. */
type Reader = Pick<Prisma.TransactionClient, 'closingEvent' | '$queryRaw'>;

export interface BusinessDayDescription {
  businessDate: string;
  timezone: string;
  /** The instants the current business date spans. */
  startsAt: string;
  endsAt: string;
  /** What a wall clock in the shop says today is. */
  localDate: string;
  /** After local midnight and before 06:00: the Owner may start the next date now. */
  canStartEarly: boolean;
  /** True when the current date was started early by the Owner. */
  startedEarly: boolean;
}

/**
 * The one place a record gets its business date (docs/50 §3.1).
 *
 * The rule itself is pure (`common/business-day.ts`); this service adds the two
 * facts only the database knows — the company's timezone, and whether the
 * Owner started the next date early — and is injected wherever a money record
 * is written, so no writer can key a day its own way.
 */
@Injectable()
export class BusinessDayService {
  private readonly logger = new Logger(BusinessDayService.name);
  private readonly warned = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContext,
  ) {}

  /**
   * The company's timezone, validated. An invalid name would make every day
   * boundary wrong, so it falls back to UTC and says so once — never silently.
   */
  async timezone(companyId: Buffer = this.tenant.companyId(), db?: Pick<Reader, '$queryRaw'>): Promise<string> {
    // Inside a caller's transaction, through that transaction. A second
    // connection taken from the pool while the transaction holds its own is
    // how as many concurrent sales as the pool has connections each wait for a
    // connection another one holds, until every one of them times out (the
    // 2026-10-03 rehearsal: three sales at once per shop on a five-connection
    // pool). Raw, because `Company` has no `companyId` column and the tenant
    // extension would inject one into a model query and refuse it — which is
    // also why, outside a transaction, the UNSCOPED client reads it.
    const stored = db
      ? (await db.$queryRaw<{ timezone: string | null }[]>(
          Prisma.sql`SELECT timezone FROM companies WHERE id = ${companyId} LIMIT 1`,
        ))[0]?.timezone
      : (await this.prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } }))?.timezone;
    const tz = stored?.trim() || 'UTC';
    if (isValidTimezone(tz)) return tz;
    const key = companyId.toString('hex');
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.error(`Company ${key} has an unknown timezone "${tz}"; business days fall back to UTC`);
    }
    return 'UTC';
  }

  /**
   * The business date a new record at this branch belongs to.
   *
   * The natural rule, unless the Owner started the following date early and
   * did so at or before this instant — then it is that date. Passing the
   * transaction client keeps the lookup inside the caller's transaction.
   */
  async assign(branchId: Buffer, instant: Date, db?: Reader): Promise<string> {
    const companyId = this.tenant.companyId();
    const tz = await this.timezone(companyId, db);
    const natural = businessDateOf(instant, tz);
    const next = shiftDate(natural, 1);
    const early = await (db ?? this.prisma).closingEvent.findFirst({
      where: { companyId, branchId, kind: 'day_started_early', businessDate: dateValue(next), at: { lte: instant } },
      select: { id: true },
    });
    return early ? next : natural;
  }

  /** The branch's current business date. */
  async today(branchId: Buffer, db?: Reader): Promise<string> {
    return this.assign(branchId, new Date(), db);
  }

  /** The instants a business date spans at this company's zone. */
  async windowOf(date: string, companyId: Buffer = this.tenant.companyId()): Promise<DayWindow> {
    return dayWindow(date, await this.timezone(companyId));
  }

  /** Everything a screen needs to say which day it is showing and why. */
  async describe(branchId: Buffer, now: Date = new Date()): Promise<BusinessDayDescription> {
    const companyId = this.tenant.companyId();
    const tz = await this.timezone(companyId);
    const businessDate = await this.assign(branchId, now);
    const natural = businessDateOf(now, tz);
    const window = dayWindow(businessDate, tz);
    return {
      businessDate,
      timezone: tz,
      startsAt: window.start.toISOString(),
      endsAt: window.end.toISOString(),
      localDate: localDateOf(now, tz),
      canStartEarly: businessDate === natural && isBeforeDayStart(now, tz, businessDate),
      startedEarly: businessDate !== natural,
    };
  }
}
