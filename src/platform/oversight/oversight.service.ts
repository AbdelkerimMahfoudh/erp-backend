import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SubscriptionNoticeKind, SubscriptionNoticeState } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { binToUuid } from '../../common/utils/uuid.util';
import { CLOCK, type Clock } from '../../entitlement/clock';
import { EntitlementService } from '../../entitlement/entitlement.service';
import { GRACE_ALLOWANCE, GRACE_HOURS, GRACE_WINDOW_MONTHS, graceWindowStart } from '../../entitlement/grace-rules';
import { NoticeService } from '../../notices/notice.service';

/**
 * What the platform console reads about the subscription lifecycle across businesses (0099; docs/101 §7): the
 * subscription messages and what became of each, the grace decisions against the allowance, and the free trials
 * claimed. Reads only — nothing here changes a business, sends a message or decides a grace — over the unscoped client,
 * because the console looks across businesses.
 *
 * What it returns is what support needs and no more: a business by its name and Store ID, a destination masked as the
 * Owner is shown it, a reason by its code. No message body, no whole contact, nothing of a shop's trade.
 */

export const OVERSIGHT_PAGE_SIZE = 50;

const STATES = new Set<string>(Object.values(SubscriptionNoticeState));
const KINDS = new Set<string>(Object.values(SubscriptionNoticeKind));

const BUSINESS = { select: { id: true, name: true, publicStoreId: true } } as const;

const NOTICE = {
  id: true,
  kind: true,
  threshold: true,
  variant: true,
  state: true,
  channel: true,
  destinationMasked: true,
  fallbackReason: true,
  failureReason: true,
  cancelReason: true,
  attempts: true,
  requestedByUserId: true,
  dueAt: true,
  acceptedAt: true,
  completedAt: true,
  createdAt: true,
} satisfies Prisma.SubscriptionNoticeSelect;

type NoticeRecord = Prisma.SubscriptionNoticeGetPayload<{ select: typeof NOTICE }>;
type BusinessRecord = { id: Buffer; name: string; publicStoreId: string };

const businessOf = (b: BusinessRecord) => ({ id: binToUuid(b.id), name: b.name, publicStoreId: b.publicStoreId });

/** A message as the console lists it: which, its state and channel, the masked destination, each recorded reason. */
function noticeView(n: NoticeRecord) {
  return {
    id: binToUuid(n.id),
    kind: n.kind,
    threshold: n.threshold,
    variant: n.variant,
    state: n.state,
    channel: n.channel,
    destination: n.destinationMasked,
    fallbackReason: n.fallbackReason,
    failureReason: n.failureReason,
    cancelReason: n.cancelReason,
    attempts: n.attempts,
    /** Asked for by the Owner on the portal (the instructions sent again), never by the timeline. */
    resend: n.requestedByUserId !== null,
    dueAt: n.dueAt.toISOString(),
    acceptedAt: n.acceptedAt?.toISOString() ?? null,
    completedAt: n.completedAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
  };
}

/** A page number from the query: 1 for anything that is not a positive whole number. */
export function pageOf(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

@Injectable()
export class PlatformOversightService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlement: EntitlementService,
    private readonly notices: NoticeService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Every subscription message, newest first, filtered by state and kind; with the count of each state over all of them. */
  async noticeLog(filter: { state?: string; kind?: string; page: number }) {
    if (filter.state && !STATES.has(filter.state)) throw new BadRequestException({ code: 'invalid_filter', message: 'Unknown message state.' });
    if (filter.kind && !KINDS.has(filter.kind)) throw new BadRequestException({ code: 'invalid_filter', message: 'Unknown message kind.' });
    const where: Prisma.SubscriptionNoticeWhereInput = {
      ...(filter.state ? { state: filter.state as SubscriptionNoticeState } : {}),
      ...(filter.kind ? { kind: filter.kind as SubscriptionNoticeKind } : {}),
    };
    const [rows, total, byState] = await Promise.all([
      this.prisma.subscriptionNotice.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (filter.page - 1) * OVERSIGHT_PAGE_SIZE,
        take: OVERSIGHT_PAGE_SIZE,
        select: { ...NOTICE, company: BUSINESS },
      }),
      this.prisma.subscriptionNotice.count({ where }),
      this.prisma.subscriptionNotice.groupBy({ by: ['state'], _count: { _all: true } }),
    ]);
    const counts = Object.fromEntries([...STATES].map((s) => [s, 0])) as Record<SubscriptionNoticeState, number>;
    for (const g of byState) counts[g.state] = g._count._all;
    return {
      rows: rows.map(({ company, ...n }) => ({ ...noticeView(n), business: businessOf(company) })),
      total,
      page: filter.page,
      pageSize: OVERSIGHT_PAGE_SIZE,
      byState: counts,
    };
  }

  /** One business's messages: the timeline as things stand (the next due, the newest), and its last fifty. */
  async businessNotices(companyId: Buffer) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
    if (!company) throw new NotFoundException({ code: 'unknown_business', message: 'Unknown business.' });
    const [timeline, rows] = await Promise.all([
      this.notices.timelineOf(companyId),
      this.prisma.subscriptionNotice.findMany({ where: { companyId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: OVERSIGHT_PAGE_SIZE, select: NOTICE }),
    ]);
    return { timeline, messages: rows.map(noticeView) };
  }

  /**
   * The grace decisions, newest first — each granted or refused, with the activations counted before it — and, now:
   * how many graces run, and how many businesses have used all three of their rolling 12 months.
   */
  async graceUsage(page: number) {
    const now = this.clock.now();
    const select = {
      id: true,
      periodEnd: true,
      decision: true,
      startedAt: true,
      endsAt: true,
      usesBefore: true,
      recordedBy: true,
      recordedAt: true,
      subscription: { select: { currentPeriodEnd: true, status: true } },
    } satisfies Prisma.GraceEpisodeSelect;
    type Episode = Prisma.GraceEpisodeGetPayload<{ select: typeof select }>;
    // Running now: granted, within its 72 hours, and still the period's grace — not renewed past it, not stopped.
    const running = (e: Episode) =>
      e.decision === 'granted' &&
      e.startedAt.getTime() <= now.getTime() &&
      now.getTime() < e.endsAt.getTime() &&
      e.subscription.status === 'activated' &&
      e.subscription.currentPeriodEnd?.getTime() === e.periodEnd.getTime();
    const [rows, total, live, inWindow] = await Promise.all([
      this.prisma.graceEpisode.findMany({
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * OVERSIGHT_PAGE_SIZE,
        take: OVERSIGHT_PAGE_SIZE,
        select: { ...select, company: { select: { ...BUSINESS.select, timezone: true } } },
      }),
      this.prisma.graceEpisode.count(),
      this.prisma.graceEpisode.findMany({ where: { decision: 'granted', startedAt: { lte: now }, endsAt: { gt: now } }, select }),
      this.prisma.graceEpisode.groupBy({
        by: ['companyId'],
        where: { decision: 'granted', startedAt: { gt: graceWindowStart(now), lte: now } },
        _count: { _all: true },
      }),
    ]);
    return {
      rules: { allowance: GRACE_ALLOWANCE, windowMonths: GRACE_WINDOW_MONTHS, durationHours: GRACE_HOURS },
      summary: {
        running: live.filter(running).length,
        atAllowance: inWindow.filter((g) => g._count._all >= GRACE_ALLOWANCE).length,
        withUse: inWindow.length,
      },
      rows: rows.map((e) => ({
        id: binToUuid(e.id),
        business: businessOf(e.company),
        decision: e.decision,
        periodEnd: e.periodEnd.toISOString(),
        startedAt: e.startedAt.toISOString(),
        endsAt: e.endsAt.toISOString(),
        usesBefore: e.usesBefore,
        recordedBy: e.recordedBy,
        recordedAt: e.recordedAt.toISOString(),
        running: running(e),
        timeZone: this.entitlement.trialZone(e.company.id, e.company.timezone),
      })),
      total,
      page,
      pageSize: OVERSIGHT_PAGE_SIZE,
      calculatedAt: now.toISOString(),
    };
  }

  /** The free trials claimed, newest first — running or ended — and how many eligible businesses have not claimed yet. */
  async trialClaims(filter: { status?: string; page: number }) {
    if (filter.status && filter.status !== 'active' && filter.status !== 'expired') {
      throw new BadRequestException({ code: 'invalid_filter', message: 'Unknown trial status.' });
    }
    const now = this.clock.now();
    const where: Prisma.TrialClaimWhereInput =
      filter.status === 'active' ? { endsAt: { gt: now } } : filter.status === 'expired' ? { endsAt: { lte: now } } : {};
    const [rows, total, active, expired, unclaimed] = await Promise.all([
      this.prisma.trialClaim.findMany({
        where,
        orderBy: [{ claimedAt: 'desc' }, { id: 'desc' }],
        skip: (filter.page - 1) * OVERSIGHT_PAGE_SIZE,
        take: OVERSIGHT_PAGE_SIZE,
        select: {
          id: true,
          claimedAt: true,
          endsAt: true,
          expiryRecordedAt: true,
          termsVersion: true,
          company: { select: { ...BUSINESS.select, timezone: true, trialEligibility: { select: { registrationMethod: true } } } },
        },
      }),
      this.prisma.trialClaim.count({ where }),
      this.prisma.trialClaim.count({ where: { endsAt: { gt: now } } }),
      this.prisma.trialClaim.count({ where: { endsAt: { lte: now } } }),
      this.prisma.trialEligibility.count({ where: { closedAt: null, company: { trialClaim: null } } }),
    ]);
    return {
      summary: { active, expired, eligibleUnclaimed: unclaimed },
      rows: rows.map((c) => ({
        id: binToUuid(c.id),
        business: businessOf(c.company),
        registrationMethod: c.company.trialEligibility?.registrationMethod ?? null,
        status: c.endsAt.getTime() > now.getTime() ? ('active' as const) : ('expired' as const),
        claimedAt: c.claimedAt.toISOString(),
        endsAt: c.endsAt.toISOString(),
        expiryRecordedAt: c.expiryRecordedAt?.toISOString() ?? null,
        termsVersion: c.termsVersion,
        timeZone: this.entitlement.trialZone(c.company.id, c.company.timezone),
      })),
      total,
      page: filter.page,
      pageSize: OVERSIGHT_PAGE_SIZE,
      calculatedAt: now.toISOString(),
    };
  }
}
