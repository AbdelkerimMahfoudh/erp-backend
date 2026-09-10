import { readFileSync } from 'node:fs';
import { DiscountApprovalStatus } from '@prisma/client';
import { APPROVAL_TTL_MINUTES } from './discount-approvals.service';
import { ROLE_PERMISSIONS } from '../rbac/role-permissions';

/**
 * The approval lifecycle, and the invariants that keep it from becoming a
 * permission.
 *
 * The rule (A2, as corrected by the owner): **the configured selling price is
 * the floor**, not cost. Selling below it needs the Owner's approval even when
 * the sale is still profitable. Below cost is a high-risk subset — same
 * approval, plus a reason.
 *
 * The database-shaped behaviour (atomic consumption, voiding, concurrency) is
 * proved over real MySQL in the CP6 run; what is pinned here is the shape of
 * the rules, which is where a regression would be silent.
 */

const source = (p: string) => readFileSync(p, 'utf8');

/** An assertion that reads the code's own explanation of itself proves nothing. */
const withoutComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const SERVICE = source('src/discount-approvals/discount-approvals.service.ts');
const CONTROLLER = source('src/discount-approvals/discount-approvals.controller.ts');
const POLICY = source('src/sales/sales-policy.service.ts');
const SALES = source('src/sales/sales.service.ts');
const SCHEMA = source('prisma/schema.prisma');

describe('the floor is the configured selling price', () => {
  it('the policy compares against the configured price, not cost', () => {
    expect(POLICY).toMatch(/configuredPrice/);
    expect(POLICY).toMatch(/belowFloor/);
    // The old rule computed a margin and called that the floor.
    expect(POLICY).not.toMatch(/assertBelowCostAllowed/);
  });

  it('treats below-cost as a subset, not a separate gate', () => {
    // Both thresholds lead to the same requirement: an Owner approval. Below
    // cost adds a reason; it does not add a different door.
    expect(POLICY).toMatch(/belowCost/);
    expect(POLICY).toMatch(/A reason is required to sell below cost/);
  });

  it('has no price floor when the ladder says unpriced', () => {
    expect(POLICY).toMatch(/configuredPrice !== null/);
  });

  it('checks per line, never on the sale total', () => {
    /*
     * An aggregate margin check lets a healthy line pay for a ruinous one: a
     * good accessory margin and a phone far below its price still totals
     * positive. The configured price is a decision about one product.
     */
    expect(SALES).toMatch(/for \(const line of prepared\)/);
    expect(SALES).toMatch(/assertPriceAllowed/);
  });

  it('uses the same price resolver as the sale', () => {
    // A second way to answer "what does this sell for?" is the divergence
    // `price-resolution.ts` exists to prevent.
    expect(SERVICE).toMatch(/resolveForSaleTx/);
  });
});

describe('an approval is not a permission', () => {
  it('is Owner-only to grant', () => {
    const holders = Object.entries(ROLE_PERMISSIONS)
      .filter(([, keys]) => keys.includes('discount.override'))
      .map(([role]) => role);
    expect(holders).toEqual(['owner']);
  });

  it('was removed from the legacy branch_manager role', () => {
    // Retired, but still mapped for older sessions — leaving the key would let
    // a legacy assignment approve its own discounts.
    expect(ROLE_PERMISSIONS.branch_manager).not.toContain('discount.override');
  });

  it('no longer lets its holder bypass the workflow', () => {
    // The permission does not authorise a sale in the policy at all. Only a
    // consumed approval does.
    expect(POLICY).not.toMatch(/hasOverride/);
    expect(POLICY).toMatch(/approval/);
  });

  it('requesting needs only the permission to make the sale', () => {
    expect(CONTROLLER).toMatch(/@RequirePermissions\('sale\.create'\)[\s\S]{0,200}request\(/);
  });

  it('deciding needs discount.override', () => {
    expect(CONTROLLER).toMatch(/@RequirePermissions\('discount\.override'\)[\s\S]{0,200}decide\(/);
  });

  it('lets an Owner approve their own request, through the same workflow', () => {
    /*
     * Deliberate. An Owner holds both permissions, so their own exception goes
     * through the audited lifecycle instead of happening invisibly — which is
     * the point of the workflow, not a hole in it.
     */
    expect(CONTROLLER).toMatch(/approve their own request/);
  });
});

describe('one sale, one unit, one price', () => {
  it('expires in thirty minutes', () => {
    expect(APPROVAL_TTL_MINUTES).toBe(30);
  });

  it('is spent by a conditional update, not a read-then-write', () => {
    /*
     * The concurrency control. Two sales racing for one approval both attempt
     * the update; MySQL serialises them on the row and exactly one sees a
     * count of 1. Reading first would let both see `approved`.
     */
    const consume = SERVICE.slice(SERVICE.indexOf('async consume('));
    expect(consume).toMatch(/updateMany\(\{[\s\S]{0,200}status: DiscountApprovalStatus\.approved/);
    expect(consume).toMatch(/count === 0/);
    expect(consume).toMatch(/approval_already_used/);
  });

  it('makes the sale use the APPROVED price, not the requested one', () => {
    // An approval for 15 000 must never authorise a sale at 1 500.
    expect(SERVICE).toMatch(/approvedPrice: Number\(row\.approvedPrice\)/);
    expect(POLICY).toMatch(/approval\.approvedPrice - price/);
  });

  it('freezes the approved price at the decision', () => {
    expect(SERVICE).toMatch(/approvedPrice: input\.approve \? current\.requestedPrice : null/);
  });
});

describe('what voids an approval', () => {
  it.each([
    ['the configured price moved', 'price_changed'],
    ['the confirmed cost moved', 'cost_changed'],
    ['the unit went to another branch', 'unit_transferred'],
    ['the unit was sold', 'unit_sold'],
    ['nobody decided in time', 'expired'],
  ])('%s → %s', (_label, reason) => {
    expect(SERVICE).toContain(reason);
  });

  it('re-compares every snapshot at consumption', () => {
    // A decision made about a different world is not a decision about this sale.
    const stale = SERVICE.slice(SERVICE.indexOf('private staleReason('));
    expect(stale).toMatch(/unitBranchId/);
    expect(stale).toMatch(/configuredPrice/);
    expect(stale).toMatch(/priceVersion/);
    expect(stale).toMatch(/unitCost/);
  });

  it('expires lazily rather than with a scheduler', () => {
    /*
     * A row nobody has looked at since it lapsed is doing no harm, and the
     * moment anyone reads it — including the sale that would consume it — it
     * settles honestly. A background job to change a status nobody is observing
     * would be infrastructure for its own sake.
     */
    expect(SERVICE).toMatch(/settleIfStale/);
    expect(SERVICE).not.toMatch(/@Cron|setInterval/);
  });
});

describe('the six states', () => {
  it.each(['pending', 'approved', 'rejected', 'expired', 'voided', 'consumed'])(
    'the schema declares %s',
    (state) => {
      const block = SCHEMA.slice(SCHEMA.indexOf('enum DiscountApprovalStatus'));
      expect(block.slice(0, 400)).toContain(state);
    },
  );

  it('every one exists in the client enum too', () => {
    for (const state of ['pending', 'approved', 'rejected', 'expired', 'voided', 'consumed']) {
      expect(Object.values(DiscountApprovalStatus)).toContain(state);
    }
  });
});

describe('the immutable snapshots', () => {
  it.each([
    'configured_price',
    'price_source',
    'price_version',
    'unit_cost',
    'requested_price',
    'discount_amount',
    'below_cost',
    'unit_branch_id',
    'requester_id',
    'reason',
    'expires_at',
  ])('the table records %s', (column) => {
    const block = SCHEMA.slice(SCHEMA.indexOf('model DiscountApproval'), SCHEMA.indexOf('enum DiscountApprovalStatus'));
    expect(block).toContain(column);
  });

  it('records the decision separately from the request', () => {
    const block = SCHEMA.slice(SCHEMA.indexOf('model DiscountApproval'), SCHEMA.indexOf('enum DiscountApprovalStatus'));
    for (const column of ['approver_id', 'decided_at', 'approved_price', 'decision_note', 'version']) {
      expect(block).toContain(column);
    }
  });

  it('carries the idempotency pair every other mutation uses', () => {
    const block = SCHEMA.slice(SCHEMA.indexOf('model DiscountApproval'), SCHEMA.indexOf('enum DiscountApprovalStatus'));
    expect(block).toContain('client_uuid');
    expect(block).toContain('client_request_hash');
    expect(SERVICE).toMatch(/idempotency_conflict/);
  });
});

describe('what a client is shown', () => {
  it('never carries cost or margin', () => {
    /*
     * `CostGatingInterceptor` would strip them anyway, but they are not put in
     * at all. An Owner reviewing a request needs the configured price, the
     * requested price and the discount — and `belowCost` as a flag. The cost
     * itself lives on the unit, behind the gate that already governs it.
     */
    const present = SERVICE.slice(SERVICE.indexOf('private present('));
    expect(present).not.toMatch(/\bcost:/);
    expect(present).not.toMatch(/\bmargin\b/);
    expect(present).toMatch(/belowCost: row\.belowCost/);
  });

  it('the audit row records the discount, not the cost', () => {
    /*
     * An audit log holding the shop's cost would be a second copy of exactly
     * what the cost gate exists to control. Scoped to the `after` object of the
     * request event rather than a character window, so the assertion cannot
     * drift onto neighbouring code.
     */
    const start = SERVICE.indexOf("event: 'discount_approval_requested'");
    expect(start).toBeGreaterThan(-1);
    // Comments stripped: the code says "no cost, no margin" in prose, and an
    // assertion that reads its own explanation proves nothing.
    const after = withoutComments(SERVICE.slice(start, SERVICE.indexOf('},', start)));
    expect(after).toMatch(/discountAmount/);

    // No cost FIGURE and no margin figure.
    expect(after).not.toMatch(/unitCost/);
    expect(after).not.toMatch(/margin/);

    /*
     * `belowCost` is present and belongs there: it is a boolean the Owner needs
     * in order to judge the request, and it discloses no amount. The
     * distinction that matters is between "this sale loses money" and "the shop
     * pays 9 800 for this" — the first is the decision, the second is the thing
     * the cost gate protects.
     */
    expect(after).toMatch(/belowCost,/);
  });
});

describe('notifications', () => {
  it('are deduplicated per approval and per event', () => {
    // A retried decision cannot produce a second message.
    expect(SERVICE).toMatch(/dedupeKey: `discount_approval:\$\{[^}]+\}:requested`/);
    expect(SERVICE).toMatch(/dedupeKey: `discount_approval:\$\{[^}]+\}:decided`/);
  });

  it('reach approvers by permission, not by a hardcoded role name', () => {
    expect(SERVICE).toMatch(/permission: 'discount\.override'/);
  });
});
