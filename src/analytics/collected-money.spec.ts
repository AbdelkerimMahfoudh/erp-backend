import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "Money collected" — what it counts, and the four things it must never become.
 *
 * Read from the source rather than driven through a database, for the same
 * reason `sale-receiving-account.spec.ts` is: the guarantees that matter here
 * are about WHICH table is asked and HOW the window is bounded, and a fixture
 * that happens to produce the right total proves neither.
 *
 * The figure exists because nothing else answered the question. `cash
 * .salesReceived` is net REVENUE used as a stand-in — what was billed, not what
 * arrived — so a credit sale inflated it and a payment against an older sale
 * was missing from it altogether.
 */
const SOURCE = readFileSync(join(__dirname, 'summary.service.ts'), 'utf8');

/**
 * Just the one method.
 *
 * Bounded at both ends deliberately: slicing only from the start runs on to the
 * end of the file, so `balances()` below — which legitimately discusses refund
 * liability — would satisfy assertions about what this method does NOT mention.
 * The first version of this file did exactly that and passed for the wrong
 * reason.
 */
const COLLECTED_METHOD = (() => {
  const start = SOURCE.indexOf('private async collectedInPeriod');
  const end = SOURCE.indexOf('What is owed right now', start);
  if (start < 0 || end < 0) throw new Error('collectedInPeriod not found in summary.service.ts');
  return SOURCE.slice(start, end);
})();

describe('money collected', () => {
  it('is counted from payments, the only record of money arriving', () => {
    expect(SOURCE).toContain('this.db.payment.groupBy');
  });

  it('is scoped to the selected branch explicitly, not left to the tenant client', () => {
    // The tenant extension scopes by COMPANY alone. Without an explicit branch
    // filter a two-shop owner reads one shop's screen and sees both shops'
    // money, with nothing on screen to say so.
    const method = COLLECTED_METHOD;
    expect(method).toContain('this.tenant.branchId()');
    expect(method).toContain('branchId ? { branchId }');
  });

  it('includes the whole of the last day of an inclusive window', () => {
    // `to` is an inclusive DAY. Bounding at its midnight would drop that day's
    // takings — the day a shopkeeper is most often looking at.
    const method = COLLECTED_METHOD;
    expect(method).toContain('86_400_000');
    expect(method).toContain('lt: end');
  });

  it('splits by payment method, so an unattributed non-cash payment is not lost', () => {
    // Splitting on `receiving_account_id` would drop every payment taken before
    // 0045, when non-cash money had no account recorded at all.
    const method = COLLECTED_METHOD;
    expect(method).toContain("by: ['method']");
    expect(method).toContain("m === 'cash'");
  });

  it('never nets refunds off the collected total', () => {
    /*
     * A refund is money going the other way and already has its own line in
     * `cash.refundsPaid`. Subtracting it here would produce a number that is
     * neither what came in nor what the shop kept, and no reader could tell
     * which one they were looking at.
     */
    const method = COLLECTED_METHOD;
    expect(method).not.toContain('refund');
    expect(method).not.toContain('returnsRevenue');
  });

  it('is documented as neither profit nor an available balance', () => {
    // Collecting an old debt moves no profit at all, and cash in hand is this
    // figure less everything that went out.
    expect(SOURCE).toContain('Never profit and never an available balance');
  });

  it('carries no cost or profit field, so cost gating has nothing to strip', () => {
    const block = SOURCE.slice(
      SOURCE.indexOf('collected: { total'),
      SOURCE.indexOf('collected: { total') + 200,
    );
    for (const financial of ['cost', 'margin', 'profit', 'cogs']) {
      expect(block.toLowerCase()).not.toContain(financial);
    }
  });
});
