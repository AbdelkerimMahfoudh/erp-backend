/**
 * Building the per-channel reconciliation (Milestone E, E-CP1).
 *
 * The E0 audit found the closing was a single cash figure. A shop taking
 * Bankily had no expected balance for it at all, so an account could drift
 * indefinitely and nothing would ever notice.
 *
 * This module is pure on purpose. Deciding WHICH channels a branch has to
 * count, and what each one is expected to hold, is the part with the rules in
 * it — so it is testable without a database.
 *
 * **It does not fork the reconciliation equation.** Every channel uses the same
 * five movements with the same signs that `reconciliation.spec.ts` pins for
 * cash:
 *
 *   expected = salesIn − refundsOut − supplierOut − expensesOut + correctionsIn
 *
 * Cash is simply the channel whose account is NULL.
 */

export type Channel = 'cash' | 'account';

/** The five movements, named exactly as the cash equation names them. */
export type Component = 'salesIn' | 'refundsOut' | 'supplierOut' | 'expensesOut' | 'correctionsIn';

/** How each component enters `expected`. The single source of the signs. */
export const COMPONENT_SIGN: Record<Component, 1 | -1> = {
  salesIn: 1,
  refundsOut: -1,
  supplierOut: -1,
  expensesOut: -1,
  correctionsIn: 1,
};

/**
 * Machine keys, not display copy. Cash and the unattributed bucket have no
 * account to take a label from, and writing English into a snapshot column
 * would make the record untranslatable and the shop's own language secondary.
 * The client renders these; the database only identifies them.
 */
export const CASH_LABEL = 'CASH';
export const UNATTRIBUTED_LABEL = 'UNATTRIBUTED';

export interface MovementRow {
  /** `null` on an account movement means the money was never attributed. */
  accountId: string | null;
  channel: Channel;
  component: Component;
  amount: number;
}

export interface AccountRow {
  id: string;
  label: string;
  isActive: boolean;
  sortOrder: number;
}

export interface ChannelRow {
  channel: Channel;
  accountId: string | null;
  labelSnapshot: string;
  /**
   * True for the bucket holding non-cash money that named no account — every
   * payment taken before 0045, and any later one the till did not attribute.
   *
   * It is reported, never hidden, and never folded into a real account's
   * expected figure. It is also **not reconcilable**: there is no balance to
   * compare it against, so asking somebody to count it would be asking them to
   * confirm a number that means nothing.
   */
  isUnattributed: boolean;
  salesIn: number;
  refundsOut: number;
  supplierOut: number;
  expensesOut: number;
  correctionsIn: number;
  /**
   * Cash only (0076): what the drawer held when the business day began — the
   * counted cash at the last locked close plus the net cash movement of any
   * unclosed day between. A balance carried forward, never income; zero for
   * accounts and for a shop that has never closed a day.
   */
  openingBalance: number;
  expected: number;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const empty = () => ({ salesIn: 0, refundsOut: 0, supplierOut: 0, expensesOut: 0, correctionsIn: 0 });

/**
 * Which channels this branch has to account for today, and what each is
 * expected to hold.
 *
 * The membership rules, and why each one exists:
 *
 * - **Cash is always present**, even on a day with no movement at all. The
 *   drawer exists whether or not it was used, and a day where nobody counted it
 *   must not read as a balanced day.
 * - **An active account is always present.** That is the whole point: an
 *   account with no movement should still be confirmed as unchanged.
 * - **A deactivated account with movement today is still present.** Money moved
 *   through it, so it is still owed a count. Deactivating an account must not
 *   be a way to stop reconciling it.
 * - **A deactivated account with no movement is dropped.** Nothing happened and
 *   nothing is expected; listing it would be asking for a count nobody needs.
 * - **The unattributed bucket appears only when it has movement.**
 */
export function buildChannels(movements: MovementRow[], accounts: AccountRow[], cashOpening = 0): ChannelRow[] {
  const totals = new Map<string, ReturnType<typeof empty>>();
  const keyOf = (channel: Channel, accountId: string | null) => `${channel}:${accountId ?? 'NONE'}`;

  const bucket = (channel: Channel, accountId: string | null) => {
    const key = keyOf(channel, accountId);
    let found = totals.get(key);
    if (!found) {
      found = empty();
      totals.set(key, found);
    }
    return found;
  };

  // Cash exists before any movement is read, so an untouched drawer is still
  // a channel somebody has to count.
  bucket('cash', null);
  for (const account of accounts) {
    if (account.isActive) bucket('account', account.id);
  }

  for (const m of movements) {
    if (m.amount === 0) continue;
    // A cash movement never belongs to an account; the database enforces the
    // same rule, and disagreeing with it here would produce a figure the
    // schema could not have stored.
    const accountId = m.channel === 'cash' ? null : m.accountId;
    bucket(m.channel, accountId)[m.component] += m.amount;
  }

  const labelOf = new Map(accounts.map((a) => [a.id, a.label]));
  const orderOf = new Map(accounts.map((a) => [a.id, a.sortOrder]));

  const rows: ChannelRow[] = [];
  for (const [key, sums] of totals) {
    const [channel, rawAccount] = key.split(':') as [Channel, string];
    const accountId = rawAccount === 'NONE' ? null : rawAccount;
    const isUnattributed = channel === 'account' && accountId === null;

    const openingBalance = channel === 'cash' ? round2(cashOpening) : 0;
    const expected = round2(
      openingBalance +
        COMPONENT_SIGN.salesIn * sums.salesIn +
        COMPONENT_SIGN.refundsOut * sums.refundsOut +
        COMPONENT_SIGN.supplierOut * sums.supplierOut +
        COMPONENT_SIGN.expensesOut * sums.expensesOut +
        COMPONENT_SIGN.correctionsIn * sums.correctionsIn,
    );

    rows.push({
      channel,
      accountId,
      labelSnapshot:
        channel === 'cash'
          ? CASH_LABEL
          : isUnattributed
            ? UNATTRIBUTED_LABEL
            : /**
               * An account that has been deleted outright cannot happen — a
               * receiving account is deactivated, never removed, precisely so a
               * recorded movement keeps pointing at something real. Falling back
               * to the sentinel rather than inventing a name means a broken
               * reference reads as unattributed instead of as a plausible lie.
               */
              (labelOf.get(accountId as string) ?? UNATTRIBUTED_LABEL),
      isUnattributed,
      salesIn: round2(sums.salesIn),
      refundsOut: round2(sums.refundsOut),
      supplierOut: round2(sums.supplierOut),
      expensesOut: round2(sums.expensesOut),
      correctionsIn: round2(sums.correctionsIn),
      openingBalance,
      expected,
    });
  }

  // Cash first — it is what the person at the till counts first. Then accounts
  // in the order the shop arranged them. Unattributed last: it is a report, not
  // a task.
  return rows.sort((a, b) => {
    if (a.channel !== b.channel) return a.channel === 'cash' ? -1 : 1;
    if (a.isUnattributed !== b.isUnattributed) return a.isUnattributed ? 1 : -1;
    const byOrder = (orderOf.get(a.accountId ?? '') ?? 0) - (orderOf.get(b.accountId ?? '') ?? 0);
    return byOrder !== 0 ? byOrder : a.labelSnapshot.localeCompare(b.labelSnapshot);
  });
}

/**
 * Whether a channel can be counted at all.
 *
 * The unattributed bucket cannot: there is no account behind it, so there is no
 * balance to compare a count against. Reporting it and asking somebody to
 * confirm it are different things, and only the first one is honest.
 */
export function isCountable(row: Pick<ChannelRow, 'isUnattributed'>): boolean {
  return !row.isUnattributed;
}

/**
 * A count is only "done" when every countable channel has either a count or a
 * recorded skip. Silence is not a state — a channel nobody touched is
 * outstanding, not agreed.
 */
export function countingComplete(
  rows: { isUnattributed: boolean; counted: number | null; isSkipped: boolean }[],
): boolean {
  return rows.filter(isCountable).every((r) => r.counted !== null || r.isSkipped);
}
