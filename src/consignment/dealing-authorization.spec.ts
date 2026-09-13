import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  mayCancel,
  mayRemove,
  newDealingRefusal,
  resolveConnectionRequest,
  type ConnectionStatusLike,
} from './dealing-authorization';
import { loanWaitingOn } from './connections.service';

/**
 * The Partners rule: new inter-store business only over an ACCEPTED connection.
 *
 * The first half is the decision itself, every combination. The second half is
 * structural — it reads the services to prove each path that starts new
 * business re-checks the rule INSIDE its commit, and each path that settles
 * existing business does not. A path that forgets the check is a bypass; a
 * settlement path that gains it traps a phone or a debt.
 */

const src = (file: string) => readFileSync(join(__dirname, '..', file), 'utf8');
const between = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  const b = s.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`markers not found: ${from} … ${to}`);
  return s.slice(a, b);
};

describe('who may start new inter-store business', () => {
  const statuses: (ConnectionStatusLike | null)[] = ['pending', 'rejected', 'cancelled', 'removed', 'blocked', null];

  it('a connected store is allowed only while the connection is accepted', () => {
    expect(newDealingRefusal({ kind: 'connected_store', connectionStatus: 'accepted' })).toBeNull();
    for (const s of statuses) {
      const refusal = newDealingRefusal({ kind: 'connected_store', connectionStatus: s });
      expect(refusal).not.toBeNull();
    }
  });

  it('says blocked distinctly, and everything else as not connected', () => {
    expect(newDealingRefusal({ kind: 'connected_store', connectionStatus: 'blocked' })?.code).toBe('connection_blocked');
    expect(newDealingRefusal({ kind: 'connected_store', connectionStatus: 'removed' })?.code).toBe('connection_not_accepted');
    expect(newDealingRefusal({ kind: 'connected_store', connectionStatus: 'pending' })?.code).toBe('connection_not_accepted');
  });

  it('refuses a store typed in by hand — the legacy manual route', () => {
    // It has no one on the other side who could ever accept a connection.
    expect(newDealingRefusal({ kind: 'manual_store', connectionStatus: null })?.code).toBe('connection_required');
    expect(newDealingRefusal({ kind: 'manual_store', connectionStatus: 'accepted' })?.code).toBe('connection_required');
  });

  it('leaves people and employees alone — they are not stores', () => {
    expect(newDealingRefusal({ kind: 'manual_person', connectionStatus: null })).toBeNull();
    expect(newDealingRefusal({ kind: 'employee', connectionStatus: null })).toBeNull();
  });

  it('every refusal tells the user existing dealings can still be settled', () => {
    for (const s of statuses) {
      const r = newDealingRefusal({ kind: 'connected_store', connectionStatus: s });
      expect(r?.message).toMatch(/still be settled/);
    }
  });
});

describe('asking to connect', () => {
  it('creates when there is no relationship', () => {
    expect(resolveConnectionRequest(null)).toEqual({ kind: 'create' });
  });

  it('treats a retry of my own pending request as the same request', () => {
    expect(resolveConnectionRequest({ status: 'pending', requesterIsMe: true })).toEqual({ kind: 'already_requested' });
  });

  it('NEVER accepts a crossed request on the other store\'s behalf', () => {
    const r = resolveConnectionRequest({ status: 'pending', requesterIsMe: false });
    expect(r.kind).toBe('refuse');
    expect(r).toMatchObject({ status: 409, code: 'connection_incoming_pending' });
  });

  it('refuses when already connected', () => {
    expect(resolveConnectionRequest({ status: 'accepted', requesterIsMe: false })).toMatchObject({
      kind: 'refuse',
      code: 'connection_already_connected',
    });
  });

  it('hides a block behind "no such store"', () => {
    expect(resolveConnectionRequest({ status: 'blocked', requesterIsMe: true })).toMatchObject({ kind: 'refuse', status: 404 });
  });

  it('reopens a rejected, cancelled or removed pair — which must be accepted again', () => {
    for (const status of ['rejected', 'cancelled', 'removed'] as const) {
      expect(resolveConnectionRequest({ status, requesterIsMe: false })).toEqual({ kind: 'reopen' });
    }
  });
});

describe('ending a request or a connection', () => {
  it('only the requester may withdraw, and only while waiting', () => {
    expect(mayCancel('pending', true)).toBe(true);
    expect(mayCancel('pending', false)).toBe(false);
    expect(mayCancel('accepted', true)).toBe(false);
  });

  it('only an accepted connection can be removed', () => {
    expect(mayRemove('accepted')).toBe(true);
    for (const s of ['pending', 'rejected', 'cancelled', 'removed', 'blocked'] as const) expect(mayRemove(s)).toBe(false);
  });
});

describe('whose move a loan is waiting for', () => {
  it('the store that did not make the offer answers it', () => {
    expect(loanWaitingOn('proposed', 'they_owe_us', true)).toBe('them');
    expect(loanWaitingOn('counter_proposed', 'they_owe_us', false)).toBe('us');
  });
  it('the debtor pays, and only the creditor confirms', () => {
    expect(loanWaitingOn('accepted', 'they_owe_us', true)).toBe('them');
    expect(loanWaitingOn('accepted', 'we_owe_them', true)).toBe('us');
    expect(loanWaitingOn('payment_awaiting_confirmation', 'they_owe_us', true)).toBe('us');
    expect(loanWaitingOn('payment_awaiting_confirmation', 'we_owe_them', true)).toBe('them');
  });
  it('closed loans wait on nobody', () => {
    expect(loanWaitingOn('settled', 'they_owe_us', true)).toBe('none');
  });
});

describe('every path that starts new business re-checks at commit', () => {
  const consignments = src('consignment/consignments.service.ts');
  const loans = src('loans/loans.service.ts');

  it('consignment creation checks inside its transaction', () => {
    const create = between(consignments, 'async create(', 'async list(');
    const tx = create.slice(create.indexOf('$transaction'));
    expect(tx).toContain('assertMayStartDealing(tx, counterparty.id)');
  });

  it('accepting or counter-offering a consignment checks; rejecting does not', () => {
    const decide = between(consignments, 'async decide(', 'async custody(');
    expect(decide).toContain("if (dto.action === 'accept' || dto.action === 'counter')");
    expect(decide).toContain('assertMayStartDealing(tx, c.counterpartyId)');
  });

  it('handing phones over checks; confirming receipt does not', () => {
    const custody = between(consignments, 'async custody(', 'async reportSold(');
    expect(custody).toContain("if (action === 'send_custody') await assertMayStartDealing(tx, c.counterpartyId)");
  });

  it('loan proposal checks inside its transaction', () => {
    const propose = between(loans, 'async propose(', 'async list(');
    const tx = propose.slice(propose.indexOf('$transaction'));
    expect(tx).toContain('assertMayStartDealing(tx, counterparty.id)');
  });

  it('accepting or countering a loan checks', () => {
    const decide = between(loans, 'async decide(', 'async payment(');
    expect(decide).toContain('assertMayStartDealing(tx, loan.counterpartyId)');
  });

  it('settlement paths never check — ending a connection must not trap a debt or a phone', () => {
    for (const [file, from, to] of [
      [consignments, 'async reportSold(', 'async payment('],
      [consignments, 'async payment(', 'async forgive('],
      [consignments, 'async forgive(', 'async returnFlow('],
      [consignments, 'async returnFlow(', 'private async ledgerRows('],
      [loans, 'async payment(', 'async forgive('],
      [loans, 'async forgive(', 'async closingReminders('],
    ] as const) {
      expect(between(file, from, to)).not.toContain('assertMayStartDealing');
    }
  });

  it('the commit-time check is a locking read, so a concurrent removal is serialised', () => {
    expect(src('consignment/dealing-authorization.ts')).toMatch(/FOR UPDATE/);
  });

  it('a store can no longer be recorded by hand', () => {
    const create = between(src('consignment/connections.service.ts'), 'async createManualCounterparty(', '// --- helpers');
    expect(create).toContain("if (input.kind === 'manual_store')");
  });
});

describe('the connected-store summary shares nothing private', () => {
  const summary = between(src('consignment/connections.service.ts'), 'async summary(', 'async listCounterparties(');

  it('never reads inventory, purchases, sales, customers or cost', () => {
    for (const forbidden of ['prisma.unit.', 'prisma.purchase', 'prisma.sale.', 'prisma.customer', 'cost', 'margin']) {
      expect(summary).not.toContain(forbidden);
    }
  });

  it('reads only dealings between exactly these two companies', () => {
    expect(summary).toContain('{ sourceCompanyId: me, destinationCompanyId: themId }');
    expect(summary).toContain('{ sourceCompanyId: themId, destinationCompanyId: me }');
    expect(summary).toContain('{ companyId: me, counterpartyCompanyId: themId }');
    expect(summary).toContain('{ companyId: themId, counterpartyCompanyId: me }');
  });

  it('keeps money owed each way separate and never nets them', () => {
    expect(summary).toContain('money: { theyOweUs: round2(theyOweUs), weOweThem: round2(weOweThem) }');
  });
});
