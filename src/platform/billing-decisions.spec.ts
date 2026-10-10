import { ConflictException } from '@nestjs/common';
import { COMPANY, makeBillingWorld, OWNER_LABEL, type BillingWorld } from './__testing__/billing-world';
import type { Activity } from '../entitlement/activity';

/**
 * The owner's binding billing decisions of 2026-10-10 (D158, docs/73 §11.1), end to end: the real store and activity
 * requests, the real confirmation, the real renewal and the real assessment, against an in-memory business whose
 * paid month (plan v3) runs from 1 October to 1 November 2026.
 *
 *  B1  a downgrade keeps the activity and the fee until the paid period ends; nothing is refunded;
 *  B2  a store taking the place of one archived this period costs nothing more when it is the same or cheaper;
 *  B3  a dearer one costs only the difference;
 *  B4  a store beside one still running pays in full — and so does an archived store brought back;
 *  B5  every replacement is written down, once, linked to both stores, the request and the money;
 *  B6  racing requests and retries never give two free replacements nor charge twice.
 *
 * "Archived" is set directly on the branch: no in-product archive action exists (docs/73 §11.6).
 */

const owner = OWNER_LABEL;
const NOV_1 = new Date('2026-11-01T00:00:00.000Z');
const DEC_1 = new Date('2026-12-01T00:00:00.000Z');

const codeOf = (e: unknown): string | undefined => ((e as ConflictException).getResponse?.() as { code?: string } | undefined)?.code;
const askStore = (w: BillingWorld, name: string, activity: Activity) =>
  w.service.requestStore(COMPANY, { name, activity, requestedBy: owner });
const askActivity = (w: BillingWorld, store: string, activity: Activity) =>
  w.service.requestActivityChange(COMPANY, { branchId: w.branch(store).id, activity, requestedBy: owner });
const fees = (w: BillingWorld, entries: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(entries).map(([name, fee]) => [w.branchId(name), fee]));

describe('B2 and B3 — a store that takes the place of one archived this paid period (the worked examples)', () => {
  it.each([
    { label: 'electronics A (500) archived; a new electronics store', archived: 'electronics', asked: 'electronics', isArchived: true, due: 0, periodAfter: 500 },
    { label: 'both A (700) archived; a new money-agent store — cheaper, nothing refunded', archived: 'both', asked: 'money_agent', isArchived: true, due: 0, periodAfter: 700 },
    { label: 'money-agent A (300) archived; a new electronics store — dearer', archived: 'money_agent', asked: 'electronics', isArchived: true, due: 200, periodAfter: 500 },
    { label: 'money-agent A (300) archived; a new both store', archived: 'money_agent', asked: 'both', isArchived: true, due: 400, periodAfter: 700 },
    { label: 'electronics A (500) still active; a new electronics store — two stores at once (B4)', archived: 'electronics', asked: 'electronics', isArchived: false, due: 500, periodAfter: 1000 },
  ] as const)('$label → $due due, the period at $periodAfter', async ({ archived, asked, isArchived, due, periodAfter }) => {
    const w = await makeBillingWorld({ stores: [{ name: 'A', activity: archived }] });
    if (isArchived) w.archive('A');

    // What the Owner's page offers is what asking then does.
    const offered = (await w.service.activityOptions(COMPANY)).newStore.find((o) => o.activity === asked)!;
    expect(offered).toMatchObject({ dueNow: due, replaces: isArchived ? { branchId: w.branchId('A'), name: 'A' } : null });

    const { allocation } = await askStore(w, 'N', asked);
    expect(allocation.replaces?.name ?? null).toBe(isArchived ? 'A' : null);
    if (due === 0) {
      expect(allocation).toMatchObject({ status: 'granted', monthlyAmount: 0, branchName: 'N' });
    } else {
      expect(allocation).toMatchObject({ status: 'pending_payment', monthlyAmount: due, branchId: null });
      await w.confirm(allocation.id, due);
    }
    expect(w.branch('N')).toMatchObject({ isActive: true, activity: asked });
    expect(w.period().assessedBranchFee).toBe(periodAfter);
    expect(w.t.payments).toHaveLength(due === 0 ? 0 : 1);
    expect(w.t.branchReplacements).toHaveLength(isArchived ? 1 : 0);
  });

  it('nothing to pay: the store opens at once, granted, and the decision is written down for good (B2, B5)', async () => {
    const w = await makeBillingWorld({ stores: [{ name: 'A', activity: 'electronics' }] });
    w.archive('A');
    const r = await askStore(w, 'N', 'electronics');

    expect(r.created).toBe(true);
    expect(r.allocation).toMatchObject({
      kind: 'store',
      status: 'granted',
      label: 'N',
      activityTo: 'electronics',
      monthlyAmount: 0,
      branchId: w.branchId('N'),
      branchName: 'N',
      replaces: { branchId: w.branchId('A'), name: 'A', credit: 500 },
      confirmedBy: owner,
    });
    // Opened exactly as a paid store opens: the Owner assigned, the subscribed count raised.
    expect(w.branch('N')).toMatchObject({ type: 'store', activity: 'electronics', isActive: true });
    expect(w.t.userBranches).toHaveLength(1);
    expect(w.subscription().subscribedBranchCount).toBe(2);
    expect(w.t.payments).toHaveLength(0);

    const [link] = w.t.branchReplacements;
    expect(link).toMatchObject({
      decision: 'no_additional_charge',
      slotFee: 500,
      replacementFee: 500,
      chargedDifference: 0,
      paymentId: null,
      decidedBy: owner,
      archivedActivity: 'electronics',
      replacementActivity: 'electronics',
    });
    expect(link.archivedBranchId.equals(w.branch('A').id)).toBe(true);
    expect(link.replacementBranchId.equals(w.branch('N').id)).toBe(true);
    expect(link.seatAllocationId.equals(w.request(r.allocation.id).id)).toBe(true);
    expect(link.billingPeriodId.equals(w.period().id)).toBe(true);

    // Nothing charged and nothing refunded: the period keeps its 500 and knows both locations.
    expect(w.period()).toMatchObject({ assessedBranchFee: 500, assessedTotal: 500, assessedActivityFeeByBranch: fees(w, { A: 500, N: 500 }) });
    expect(w.t.events.map((e) => e.kind)).toEqual(['store_requested', 'branches_changed']);
    expect(w.t.events[0].note).toMatch(/replacing "A", archived this period: 0 MRU/);
    expect(w.t.auditLogs).toEqual([
      expect.objectContaining({
        entityType: 'BranchReplacement',
        action: 'create',
        after: expect.objectContaining({ archivedStore: 'A', replacementStore: 'N', slotFee: 500, chargedDifference: 0, decision: 'no_additional_charge' }),
      }),
    ]);
    expect(w.locks[0]).toMatch(/FROM subscriptions WHERE company_id = \? FOR UPDATE/);
  });

  it('a dearer store pays the difference, and opens at the payment’s confirmation with the replacement on record (B3, B5)', async () => {
    const w = await makeBillingWorld({ stores: [{ name: 'A', activity: 'money_agent' }] });
    w.archive('A');
    const { allocation } = await askStore(w, 'N', 'electronics');
    expect(allocation).toMatchObject({ status: 'pending_payment', monthlyAmount: 200, replaces: { name: 'A', credit: 300 }, branchId: null });
    expect(w.t.events[0].note).toMatch(/replacing "A", archived this period: 200 MRU for this period \(the difference; 300 MRU already paid/);
    // Asking creates nothing a shop could sell from.
    expect(() => w.branch('N')).toThrow();

    const c = await w.confirm(allocation.id, 200);
    expect(c.allocation).toMatchObject({ status: 'paid', branchId: w.branchId('N'), branchName: 'N', replaces: { name: 'A', credit: 300 } });
    expect(w.t.branchReplacements).toEqual([
      expect.objectContaining({ decision: 'difference_charged', slotFee: 300, replacementFee: 500, chargedDifference: 200, decidedBy: 'ops@example.test' }),
    ]);
    expect(w.t.branchReplacements[0].paymentId.equals(w.t.payments[0].id)).toBe(true);
    expect(w.period()).toMatchObject({ assessedBranchFee: 500, assessedActivityFeeByBranch: fees(w, { A: 300, N: 500 }) });
    expect(w.platformAudits[0]).toMatchObject({
      action: 'store.payment_confirm',
      after: {
        storeOpened: 'N',
        replacement: { archivedStore: 'A', archivedBranchId: w.branchId('A'), slotFee: 300, replacementFee: 500, chargedDifference: 200, decision: 'difference_charged' },
      },
    });
    expect(w.t.events.map((e) => e.kind)).toEqual(['store_requested', 'branches_changed', 'seat_paid']);
  });

  it('with several slots: the smallest that covers the store in full, keeping a larger one for a dearer store', async () => {
    const w = await makeBillingWorld({ stores: [{ name: 'Big', activity: 'both' }, { name: 'Small', activity: 'electronics' }] });
    w.archive('Big');
    w.archive('Small');
    const first = await askStore(w, 'N1', 'electronics');
    expect(first.allocation).toMatchObject({ status: 'granted', replaces: { name: 'Small', credit: 500 } });
    const second = await askStore(w, 'N2', 'both');
    expect(second.allocation).toMatchObject({ status: 'granted', replaces: { name: 'Big', credit: 700 } });
    expect(w.period().assessedBranchFee).toBe(1200);
    // Both places taken: a third store is a store more.
    expect((await askStore(w, 'N3', 'electronics')).allocation).toMatchObject({ status: 'pending_payment', monthlyAmount: 500, replaces: null });
  });

  it('no slot without a paid month running: a lapsed shop’s store is priced in full, and nothing is reserved', async () => {
    const w = await makeBillingWorld({ stores: [{ name: 'A', activity: 'electronics' }] });
    w.archive('A');
    w.clock.set(new Date('2026-11-05T10:00:00.000Z'));
    const { allocation } = await askStore(w, 'N', 'electronics');
    expect(allocation).toMatchObject({ status: 'pending_payment', monthlyAmount: 500, replaces: null });
    expect(w.request(allocation.id).replacesBranchId).toBeNull();
  });

  it('no slot for a business the platform suspended: asking opens nothing, the store is priced in full and waits', async () => {
    const w = await makeBillingWorld({ stores: [{ name: 'A', activity: 'electronics' }] });
    w.archive('A');
    w.subscription().status = 'suspended';
    const { allocation } = await askStore(w, 'N', 'electronics');
    expect(allocation).toMatchObject({ status: 'pending_payment', monthlyAmount: 500, replaces: null });
    expect(w.request(allocation.id).replacesBranchId).toBeNull();
  });
});

describe('a store that replaced another, upgraded in the same period (D158)', () => {
  it('A (700) archived; R an electronics store at 0; R upgraded to both → 0: applied at once, granted, never a request for 0', async () => {
    const w = await makeBillingWorld({ stores: [{ name: 'A', activity: 'both' }] });
    w.archive('A');
    await askStore(w, 'R', 'electronics');
    const [store] = (await w.service.activityOptions(COMPANY)).stores;
    expect(store.name).toBe('R');
    expect(store.options).toEqual([
      { activity: 'money_agent', outcome: 'renewal', dueNow: 0, monthlyAfter: 300 },
      { activity: 'both', outcome: 'now', dueNow: 0, monthlyAfter: 700 },
    ]);

    const locksBefore = w.locks.length;
    const up = await askActivity(w, 'R', 'both');
    expect(up.created).toBe(true);
    expect(up.allocation).toMatchObject({
      kind: 'activity',
      status: 'granted',
      activityFrom: 'electronics',
      activityTo: 'both',
      activityEffective: 'now',
      monthlyAmount: 0,
      confirmedBy: owner,
    });
    expect(w.branch('R')).toMatchObject({ activity: 'both', activityNext: null });
    expect(w.period()).toMatchObject({ assessedBranchFee: 700, assessedActivityFeeByBranch: fees(w, { A: 700, R: 700 }) });
    expect(w.t.payments).toHaveLength(0);
    expect(w.t.events.at(-1)).toMatchObject({ kind: 'activity_changed' });
    // The subscription first, then the branch: the order every request and confirmation takes them in.
    expect(w.locks.slice(locksBefore)).toEqual([
      expect.stringMatching(/FROM subscriptions WHERE company_id = \? FOR UPDATE/),
      expect.stringMatching(/FROM branches WHERE id = \? AND company_id = \? FOR UPDATE/),
    ]);
    // In force, so it is neither withdrawn nor asked again.
    await expect(w.service.withdraw(COMPANY, w.request(up.allocation.id).id, owner)).rejects.toThrow(/awaiting payment/);
    expect(codeOf(await askActivity(w, 'R', 'both').catch((e: unknown) => e))).toBe('activity_unchanged');
  });

  it('an upgrade the credit does not cover costs exactly what it leaves: A (300) archived, R electronics (200 paid), R → both: 200', async () => {
    const w = await makeBillingWorld({ stores: [{ name: 'A', activity: 'money_agent' }] });
    w.archive('A');
    await w.confirm((await askStore(w, 'R', 'electronics')).allocation.id, 200);
    const up = await askActivity(w, 'R', 'both');
    expect(up.allocation).toMatchObject({ status: 'pending_payment', monthlyAmount: 200, activityEffective: 'now' });
    await w.confirm(up.allocation.id, 200);
    expect(w.period().assessedBranchFee).toBe(700);
  });

  it('the chain: A (300) archived; R electronics (200 paid); R archived; R2 both → 200, slot(R) = max(500, 300)', async () => {
    const w = await makeBillingWorld({ stores: [{ name: 'A', activity: 'money_agent' }] });
    w.archive('A');
    await w.confirm((await askStore(w, 'R', 'electronics')).allocation.id, 200);
    expect(w.period().assessedBranchFee).toBe(500);

    w.archive('R');
    const offered = (await w.service.activityOptions(COMPANY)).newStore.find((o) => o.activity === 'both');
    expect(offered).toEqual({ activity: 'both', monthly: 700, dueNow: 200, replaces: { branchId: w.branchId('R'), name: 'R', credit: 500 } });
    const { allocation } = await askStore(w, 'R2', 'both');
    expect(allocation).toMatchObject({ status: 'pending_payment', monthlyAmount: 200, replaces: { name: 'R', credit: 500 } });
    await w.confirm(allocation.id, 200);

    // 300 + 200 + 200: one location, charged once, at the dearest activity it ever had.
    expect(w.period().assessedBranchFee).toBe(700);
    expect(w.t.branchReplacements.map((r) => [r.slotFee, r.replacementFee, r.chargedDifference])).toEqual([
      [300, 500, 200],
      [500, 700, 200],
    ]);
  });

  it('a difference left after the credit is that period’s alone: confirmed after the roll it is refused, nothing written; asked again, priced in full', async () => {
    // Found by the review: P2 has no credit for R, so collecting the 200 would leave P2 assessed 400 more with 200 paid.
    const w = await makeBillingWorld({ stores: [{ name: 'A', activity: 'electronics' }], currentPeriodEnd: DEC_1 });
    w.archive('A');
    await askStore(w, 'R', 'money_agent');
    const up = await askActivity(w, 'R', 'both');
    expect(up.allocation).toMatchObject({ status: 'pending_payment', monthlyAmount: 200 });
    expect(w.request(up.allocation.id)).toMatchObject({ replacementCredit: 500, replacementPeriodId: w.period().id, replacesBranchId: null });

    w.clock.set(new Date('2026-11-03T09:00:00.000Z'));
    await w.service.activityOptions(COMPANY);
    expect(w.periods()).toHaveLength(2);
    expect(w.period().assessedActivityFeeByBranch).toEqual(fees(w, { R: 300 }));
    const refusal = await w.confirm(up.allocation.id, 200).catch((e: unknown) => e);
    expect(codeOf(refusal)).toBe('replacement_no_longer_applies');
    expect(w.t.payments).toHaveLength(0);
    expect(w.request(up.allocation.id)).toMatchObject({ status: 'pending_payment', version: 0 });
    expect(w.branch('R')).toMatchObject({ activity: 'money_agent' });
    expect(w.period().assessedBranchFee).toBe(300);

    await w.service.withdraw(COMPANY, w.request(up.allocation.id).id, owner);
    const again = await askActivity(w, 'R', 'both');
    expect(again.allocation).toMatchObject({ status: 'pending_payment', monthlyAmount: 400 });
    expect(w.request(again.allocation.id)).toMatchObject({ replacementCredit: null, replacementPeriodId: null });
    await w.confirm(again.allocation.id, 400);
    expect(w.period().assessedBranchFee).toBe(700);
    expect(w.t.payments.map((p) => String(p.amount))).toEqual(['400']);
  });

  it('a credit never applies a change at once for a business suspended while the request was on its way', async () => {
    // The status is read under the subscription lock: a suspension committed after the first read sends the change to
    // the renewal, priced in full there, instead of applying it at once on a credit.
    const w = await makeBillingWorld({ stores: [{ name: 'A', activity: 'both' }] });
    w.archive('A');
    await askStore(w, 'R', 'electronics');
    const renewal = (w.service as unknown as { renewal: { rollIfDue: (c: Buffer) => Promise<unknown> } }).renewal;
    jest.spyOn(renewal, 'rollIfDue').mockImplementationOnce(async () => {
      w.subscription().status = 'suspended';
    });
    const up = await askActivity(w, 'R', 'both');
    expect(up.allocation).toMatchObject({ status: 'granted', activityEffective: 'renewal', monthlyAmount: 0 });
    expect(w.branch('R')).toMatchObject({ activity: 'electronics', activityNext: 'both' });
    expect(w.period().assessedBranchFee).toBe(700);
  });
});

describe('B6 — racing requests and retries', () => {
  it('two different store requests racing for one slot: one takes it at 0, the other pays in full', async () => {
    const w = await makeBillingWorld({ stores: [{ name: 'A', activity: 'electronics' }] });
    w.archive('A');
    const answers = await Promise.all([askStore(w, 'N1', 'electronics'), askStore(w, 'N2', 'electronics')]);
    const [free, full] = [...answers].sort((x, y) => x.allocation.monthlyAmount - y.allocation.monthlyAmount);
    expect(free.allocation).toMatchObject({ status: 'granted', monthlyAmount: 0, replaces: { name: 'A' } });
    expect(full.allocation).toMatchObject({ status: 'pending_payment', monthlyAmount: 500, replaces: null });
    expect(w.t.branchReplacements).toHaveLength(1);
    await w.confirm(full.allocation.id, 500);
    expect(w.period().assessedBranchFee).toBe(1000);
  });

  it('two racing for one slot that covers neither: one pays the difference, the other in full', async () => {
    const w = await makeBillingWorld({ stores: [{ name: 'A', activity: 'money_agent' }] });
    w.archive('A');
    const answers = await Promise.all([askStore(w, 'N1', 'electronics'), askStore(w, 'N2', 'electronics')]);
    const [diff, full] = [...answers].sort((x, y) => x.allocation.monthlyAmount - y.allocation.monthlyAmount);
    expect(diff.allocation).toMatchObject({ status: 'pending_payment', monthlyAmount: 200, replaces: { name: 'A', credit: 300 } });
    expect(full.allocation).toMatchObject({ status: 'pending_payment', monthlyAmount: 500, replaces: null });
    await w.confirm(full.allocation.id, 500);
    await w.confirm(diff.allocation.id, 200);
    expect(w.period().assessedBranchFee).toBe(1000);
  });

  it('a slot reserved by an open request is invisible to the next — and free again once that request is withdrawn', async () => {
    const w = await makeBillingWorld({ stores: [{ name: 'A', activity: 'money_agent' }] });
    w.archive('A');
    const first = await askStore(w, 'N1', 'electronics');
    expect(first.allocation).toMatchObject({ monthlyAmount: 200, replaces: { name: 'A' } });
    expect((await w.service.activityOptions(COMPANY)).newStore[0]).toMatchObject({ activity: 'electronics', dueNow: 500, replaces: null });
    expect((await askStore(w, 'N2', 'electronics')).allocation).toMatchObject({ monthlyAmount: 500, replaces: null });

    await w.service.withdraw(COMPANY, w.request(first.allocation.id).id, owner);
    expect((await askStore(w, 'N3', 'electronics')).allocation).toMatchObject({ monthlyAmount: 200, replaces: { name: 'A' } });
  });

  it('the same name twice at once is one request', async () => {
    const w = await makeBillingWorld({ stores: [{ name: 'A', activity: 'money_agent' }] });
    w.archive('A');
    const [a, b] = await Promise.all([askStore(w, 'N', 'electronics'), askStore(w, 'N', 'electronics')]);
    expect(a.allocation.id).toBe(b.allocation.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(w.t.seatAllocations).toHaveLength(1);
    expect(w.t.events.filter((e) => e.kind === 'store_requested')).toHaveLength(1);
  });

  it('the same name twice at once, with nothing to pay: one store opens, the retry is told the name is taken', async () => {
    const w = await makeBillingWorld({ stores: [{ name: 'A', activity: 'electronics' }] });
    w.archive('A');
    const settled = await Promise.allSettled([askStore(w, 'N', 'electronics'), askStore(w, 'N', 'electronics')]);
    expect(settled.map((s) => s.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    expect(codeOf(refused.reason)).toBe('store_name_in_use');
    expect(w.t.branches.filter((b) => b.name === 'N')).toHaveLength(1);
    expect(w.t.seatAllocations).toHaveLength(1);
    expect(w.t.branchReplacements).toHaveLength(1);
  });

  it('confirmed twice: one payment, one store, one link — the retry is a no-op; a colleague’s stale confirmation is refused', async () => {
    const w = await makeBillingWorld({ stores: [{ name: 'A', activity: 'money_agent' }] });
    w.archive('A');
    const { allocation } = await askStore(w, 'N', 'electronics');
    const [won, lost] = await Promise.allSettled([
      w.confirm(allocation.id, 200, { expectedVersion: 0 }),
      w.confirm(allocation.id, 200, { expectedVersion: 0, reference: 'BK-dup' }),
    ]);
    expect(won.status).toBe('fulfilled');
    expect(codeOf((lost as PromiseRejectedResult).reason)).toBe('seat_request_changed');
    const again = await w.confirm(allocation.id, 200, { reference: 'BK-retry' });
    expect(again.applied).toBe(false);

    expect(w.t.payments).toHaveLength(1);
    expect(w.t.branches.filter((b) => b.name === 'N')).toHaveLength(1);
    expect(w.t.branchReplacements).toHaveLength(1);
    expect(w.request(allocation.id).branchId.equals(w.branch('N').id)).toBe(true);
    expect(w.period().assessedBranchFee).toBe(500);
  });

  it('a reserved slot whose period ended, then rolled, before confirmation: refused, nothing written; asked again, priced in full', async () => {
    const w = await makeBillingWorld({
      stores: [{ name: 'Shop', activity: 'electronics' }, { name: 'A', activity: 'money_agent' }],
      currentPeriodEnd: DEC_1,
    });
    w.archive('A');
    const { allocation } = await askStore(w, 'N', 'electronics');
    expect(allocation).toMatchObject({ monthlyAmount: 200, replaces: { name: 'A' } });
    const eventsBefore = w.t.events.length;

    const refusedOf = async () => {
      const refusal = await w.confirm(allocation.id, 200).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(ConflictException);
      expect(codeOf(refusal)).toBe('replacement_no_longer_applies');
      // Nothing charged on a stale figure: no payment, the request untouched, no store, no link.
      expect(w.t.payments).toHaveLength(0);
      expect(w.request(allocation.id)).toMatchObject({ status: 'pending_payment', version: 0, branchId: null });
      expect(w.t.branches.some((b) => b.name === 'N')).toBe(false);
      expect(w.t.branchReplacements).toHaveLength(0);
    };

    // The paid month ended; the next is paid but not yet rolled.
    w.clock.set(new Date('2026-11-03T09:00:00.000Z'));
    await refusedOf();
    // Rolled: the next period billed only what was active, and A is not in it.
    await w.service.activityOptions(COMPANY);
    expect(w.periods()).toHaveLength(2);
    expect(w.period().assessedActivityFeeByBranch).toEqual(fees(w, { Shop: 500 }));
    await refusedOf();
    expect(w.t.events.slice(eventsBefore).map((e) => e.kind)).toEqual(['renewed']);

    await w.service.withdraw(COMPANY, w.request(allocation.id).id, owner);
    expect((await askStore(w, 'N', 'electronics')).allocation).toMatchObject({ status: 'pending_payment', monthlyAmount: 500, replaces: null });
  });

  it('a reserved slot whose archived store is active again: refused, nothing written', async () => {
    const w = await makeBillingWorld({ stores: [{ name: 'A', activity: 'money_agent' }] });
    w.archive('A');
    const { allocation } = await askStore(w, 'N', 'electronics');
    w.reactivate('A');
    expect(codeOf(await w.confirm(allocation.id, 200).catch((e: unknown) => e))).toBe('replacement_no_longer_applies');
    expect(w.t.payments).toHaveLength(0);
    expect(w.request(allocation.id).status).toBe('pending_payment');
  });

  it('the unique slot key has the last word: a replacement the re-check could not see refuses the confirmation and rolls it back', async () => {
    const w = await makeBillingWorld({ stores: [{ name: 'A', activity: 'money_agent' }] });
    w.archive('A');
    const { allocation } = await askStore(w, 'N', 'electronics');
    // Another writer's replacement of the same slot, committed where the re-check's read did not see it.
    w.t.branchReplacements.push({ billingPeriodId: w.period().id, archivedBranchId: w.branch('A').id, replacementBranchId: Buffer.alloc(16, 9) });
    w.db.branchReplacement.findFirst = async () => null;

    expect(codeOf(await w.confirm(allocation.id, 200).catch((e: unknown) => e))).toBe('replacement_no_longer_applies');
    expect(w.t.payments).toHaveLength(0);
    expect(w.t.branches.some((b) => b.name === 'N')).toBe(false);
    expect(w.request(allocation.id)).toMatchObject({ status: 'pending_payment', version: 0 });
    expect(w.t.branchReplacements).toHaveLength(1);
  });
});

describe('B4 — two stores at once pay for two', () => {
  it('a store asked for while the old one still runs carries no slot and is charged in full, even if the old one is archived before payment', async () => {
    const w = await makeBillingWorld({ stores: [{ name: 'A', activity: 'electronics' }] });
    const { allocation } = await askStore(w, 'N', 'electronics');
    expect(allocation).toMatchObject({ monthlyAmount: 500, replaces: null });
    w.archive('A');
    await w.confirm(allocation.id, 500);
    expect(w.t.branchReplacements).toHaveLength(0);
    expect(w.period().assessedBranchFee).toBe(1000);
  });

  it('an archived store brought back while its replacement runs is charged in full by the assessment’s floor', async () => {
    const w = await makeBillingWorld({ stores: [{ name: 'A', activity: 'electronics' }] });
    w.archive('A');
    await askStore(w, 'R', 'electronics');
    expect(w.period().assessedBranchFee).toBe(500);

    w.reactivate('A');
    // The portal says so at once, and the next assessment (any confirmation runs one) charges it.
    expect((await w.billing.pricingFor(COMPANY)).currentPeriod).toMatchObject({ assessedBranchFee: 1000 });
    await w.billing.assessNow(COMPANY);
    expect(w.period()).toMatchObject({ assessedBranchFee: 1000, assessedTotal: 1000 });
  });
});

describe('B1 — a downgrade keeps what was paid for until the paid period ends; the lower price starts at the renewal', () => {
  it('scheduled on the 20th: the branch and the period keep 700; the roll applies money_agent and opens the next period at 300; nothing refunded', async () => {
    const w = await makeBillingWorld({ stores: [{ name: 'Main', activity: 'both' }], currentPeriodEnd: DEC_1 });
    w.clock.set(new Date('2026-10-20T10:00:00.000Z'));
    const down = await askActivity(w, 'Main', 'money_agent');
    expect(down.allocation).toMatchObject({ status: 'granted', activityEffective: 'renewal', monthlyAmount: 0, confirmedAt: null });
    expect(w.branch('Main')).toMatchObject({ activity: 'both', activityNext: 'money_agent' });

    // Until the paid period ends the shop keeps what it paid for, and the period keeps what it charged.
    const pricing = await w.billing.pricingFor(COMPANY);
    expect(pricing.currentPeriod).toMatchObject({ assessedBranchFee: 700, assessedTotal: 700 });
    expect(pricing.nextRenewalEstimate.branchFee).toBe(300);
    await w.billing.assessNow(COMPANY);
    expect(w.period()).toMatchObject({ assessedBranchFee: 700 });
    w.clock.set(new Date('2026-10-31T23:00:00.000Z'));
    await w.service.activityOptions(COMPANY);
    expect(w.periods()).toHaveLength(1);
    expect(w.branch('Main').activity).toBe('both');

    // 3 November: the roll applies the downgrade where the paid period ended, and the next period opens at 300.
    w.clock.set(new Date('2026-11-03T09:00:00.000Z'));
    await w.service.activityOptions(COMPANY);
    expect(w.branch('Main')).toMatchObject({ activity: 'money_agent', activityNext: null, activityChangedAt: NOV_1 });
    const [ended, next] = w.periods();
    expect(ended).toMatchObject({ periodEnd: NOV_1, assessedBranchFee: 700, assessedTotal: 700 });
    expect(next).toMatchObject({ periodStart: NOV_1, periodEnd: DEC_1, assessedBranchFee: 300, assessedTotal: 300, assessedActivityFeeByBranch: fees(w, { Main: 300 }) });
    expect(w.t.payments).toHaveLength(0);
    expect(w.request(down.allocation.id)).toMatchObject({ status: 'granted', confirmedBy: 'system', confirmedAt: NOV_1, reason: 'Applied at the renewal.' });
    expect(w.t.events.map((e) => e.kind)).toEqual(['activity_scheduled', 'activity_changed', 'renewed']);
  });
});
