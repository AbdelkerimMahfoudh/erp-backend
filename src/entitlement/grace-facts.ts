import type { Prisma } from '@prisma/client';
import { graceWindowStart, type GraceDecision, type GraceFacts } from './grace-rules';

/**
 * The grace facts of many businesses at once (0099), for the console's lists and tallies: one read of their recorded
 * decisions, and each business's facts computed from them exactly as the evaluation's joined read computes them
 * (`evaluation-facts.ts`) — so a list never shows grace the business itself is not given.
 */

/** One recorded decision (`grace_episodes`), as the lists read it. */
export interface GraceEpisodeRow {
  companyId: Buffer;
  periodEnd: Date;
  decision: GraceDecision;
  startedAt: Date;
  endsAt: Date;
}

/**
 * A business's facts for its current period end: the decision recorded for that end, and the granted activations
 * counted against it — started after the end's window start, its own excluded.
 */
export function graceFactsFrom(episodes: readonly GraceEpisodeRow[], periodEnd: Date | null): GraceFacts {
  if (!periodEnd) return { recorded: null, usesBefore: 0 };
  const end = periodEnd.getTime();
  const from = graceWindowStart(periodEnd).getTime();
  const own = episodes.find((e) => e.periodEnd.getTime() === end) ?? null;
  return {
    recorded: own ? { periodEnd: own.periodEnd, decision: own.decision, startedAt: own.startedAt, endsAt: own.endsAt } : null,
    usesBefore: episodes.filter((e) => e.decision === 'granted' && e.startedAt.getTime() > from && e.periodEnd.getTime() !== end).length,
  };
}

/** Every recorded decision of the businesses given, by company (hex id). */
export async function graceEpisodesOf(db: Prisma.TransactionClient, companyIds: readonly Buffer[]): Promise<Map<string, GraceEpisodeRow[]>> {
  const byCompany = new Map<string, GraceEpisodeRow[]>();
  if (companyIds.length === 0) return byCompany;
  const rows = await db.graceEpisode.findMany({
    where: { companyId: { in: [...companyIds] } },
    select: { companyId: true, periodEnd: true, decision: true, startedAt: true, endsAt: true },
  });
  for (const row of rows) {
    const key = row.companyId.toString('hex');
    byCompany.set(key, [...(byCompany.get(key) ?? []), row]);
  }
  return byCompany;
}
