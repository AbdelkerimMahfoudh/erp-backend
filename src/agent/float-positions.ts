import { Prisma } from '@prisma/client';
import type { TenantPrisma } from '../prisma/tenant.extension';
import { binToUuid, uuidToBin } from '../common/utils/uuid.util';
import { dateKey, dateValue } from '../common/business-day/business-day.service';
import { dayMovementOf, floatPosition, type DayMovement, type FloatAnchor, type LegSums } from './agent-rules';

/**
 * A provider float, or the commission a provider holds, as this app tracks it
 * at one branch (docs/73 §4.4): the latest `agent_positions` anchor plus the
 * `agent_movements` legs strictly after its instant, with the business day's
 * own legs beside it. The rules are `agent-rules.ts`; this reads what they
 * need, through the request's client or a transaction's, and is shared by the
 * Money card, the Owner's position record, the reports and the closing's float
 * counts — one reading of a float, never two.
 *
 * Cash is not read here: the drawer is the closing's (§4.5).
 */

export type FloatAccountKind = 'provider' | 'commission_held';

export interface FloatProvider {
  id: string;
  label: string;
  kind: 'bankily' | 'sedad' | 'other';
  isActive: boolean;
}

export interface FloatView {
  providerId: string;
  providerLabel: string;
  providerKind: FloatProvider['kind'];
  accountKind: FloatAccountKind;
  known: boolean;
  position: number | null;
  unknownReason: 'no_anchor' | null;
  anchor: { amount: number; at: string; businessDate: string; byName: string | null; source: FloatAnchor['source'] } | null;
  sinceAnchorNet: number | null;
  movement: DayMovement;
}

export interface FloatInputs {
  anchor: FloatAnchor | null;
  sinceAnchor: LegSums;
  day: LegSums;
}

/** The key a float carries in `unknownKeys`: its account and its provider. */
export const floatKey = (accountKind: FloatAccountKind, providerId: string): string => `${accountKind}:${providerId}`;

type FloatReader = Pick<TenantPrisma, 'agentPosition' | 'agentMovement'>;

const num = (d: Prisma.Decimal | number | null | undefined): number => (d == null ? 0 : Number(d));
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

async function legSums(client: FloatReader, where: Prisma.AgentMovementWhereInput): Promise<LegSums> {
  const rows = await client.agentMovement.groupBy({ by: ['direction'], where, _sum: { amount: true } });
  const of = (direction: 'inflow' | 'outflow') => round2(num(rows.find((r) => r.direction === direction)?._sum.amount));
  return { inflows: of('inflow'), outflows: of('outflow') };
}

/**
 * The anchor and the sums behind one float: the latest anchor at or before
 * `asOf` (now when absent), the legs strictly after it and not after `asOf`,
 * and the business day's legs — so the same read answers "now", "at the count
 * instant" and "at the end of the period".
 */
export async function readFloatInputs(
  client: FloatReader,
  args: { branchId: Buffer; providerId: Buffer; accountKind: FloatAccountKind; businessDate: string; asOf?: Date | null },
): Promise<FloatInputs> {
  const asOf = args.asOf ?? null;
  const row = await client.agentPosition.findFirst({
    where: { branchId: args.branchId, accountKind: args.accountKind, providerId: args.providerId, ...(asOf ? { at: { lte: asOf } } : {}) },
    orderBy: [{ at: 'desc' }, { createdAt: 'desc' }],
    select: { amount: true, at: true, businessDate: true, source: true, recordedByName: true, trackedBefore: true },
  });
  const anchor: FloatAnchor | null = row
    ? {
        amount: num(row.amount),
        at: row.at,
        businessDate: dateKey(row.businessDate),
        byName: row.recordedByName,
        source: row.source,
        trackedBefore: row.trackedBefore == null ? null : num(row.trackedBefore),
      }
    : null;
  const account = { branchId: args.branchId, accountKind: args.accountKind, providerId: args.providerId };
  const [sinceAnchor, day] = await Promise.all([
    anchor ? legSums(client, { ...account, recordedAt: { gt: anchor.at, ...(asOf ? { lte: asOf } : {}) } }) : Promise.resolve({ inflows: 0, outflows: 0 }),
    legSums(client, { ...account, businessDate: dateValue(args.businessDate), ...(asOf ? { recordedAt: { lte: asOf } } : {}) }),
  ]);
  return { anchor, sinceAnchor, day };
}

/** The float as the phone reads it, from its inputs. */
export function floatViewOf(provider: FloatProvider, accountKind: FloatAccountKind, businessDate: string, inputs: FloatInputs): FloatView {
  const position = floatPosition(inputs.anchor, inputs.sinceAnchor);
  return {
    providerId: provider.id,
    providerLabel: provider.label,
    providerKind: provider.kind,
    accountKind,
    ...position,
    anchor: inputs.anchor
      ? { amount: round2(inputs.anchor.amount), at: inputs.anchor.at.toISOString(), businessDate: inputs.anchor.businessDate, byName: inputs.anchor.byName, source: inputs.anchor.source }
      : null,
    movement: dayMovementOf(businessDate, inputs.day),
  };
}

export async function readFloat(
  client: FloatReader,
  provider: FloatProvider,
  accountKind: FloatAccountKind,
  args: { branchId: Buffer; businessDate: string; asOf?: Date | null },
): Promise<FloatView> {
  const inputs = await readFloatInputs(client, { branchId: args.branchId, providerId: uuidToBin(provider.id), accountKind, businessDate: args.businessDate, asOf: args.asOf });
  return floatViewOf(provider, accountKind, args.businessDate, inputs);
}

/**
 * Which float and held-commission accounts of the branch ever held or moved
 * money: an inactive provider with a position or a movement is still listed —
 * switching it off is not a way to stop tracking its money.
 */
export async function accountsWithMoney(client: FloatReader, branchId: Buffer): Promise<Set<string>> {
  const kinds: FloatAccountKind[] = ['provider', 'commission_held'];
  const [anchored, moved] = await Promise.all([
    client.agentPosition.groupBy({ by: ['accountKind', 'providerId'], where: { branchId, accountKind: { in: kinds } } }),
    client.agentMovement.groupBy({ by: ['accountKind', 'providerId'], where: { branchId, accountKind: { in: kinds } } }),
  ]);
  const keys = new Set<string>();
  for (const row of [...anchored, ...moved]) {
    if (row.providerId) keys.add(floatKey(row.accountKind as FloatAccountKind, binToUuid(row.providerId)));
  }
  return keys;
}
