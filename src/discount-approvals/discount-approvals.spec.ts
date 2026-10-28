import { readFileSync } from 'node:fs';
import { DiscountApprovalStatus } from '@prisma/client';
import { APPROVAL_TTL_MINUTES } from './discount-approvals.service';
import { ROLE_PERMISSIONS } from '../rbac/role-permissions';
import { FINANCIAL_FIELDS } from '../common/interceptors/financial-fields';

/**
 * The approval lifecycle, and the invariants that keep it from becoming a
 * permission.
 *
 * The rule (D223, 2026-10-27, replacing A2): **there is no price floor**; the
 * configured selling price is a suggestion. Selling below COST is what stays
 * guarded: the Owner and Store Managers (`sale.below_cost`) may do it after a
 * high-friction warning and with a reason, and anyone else needs one of them
 * to approve that exact unit at that exact price.
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

describe('no price floor; a loss is guarded (D223)', () => {
  it('the policy measures the price against cost only', () => {
    const code = withoutComments(POLICY);
    expect(code).not.toMatch(/belowFloor/);
    expect(code).not.toMatch(/configuredPrice/);
    expect(code).toMatch(/price >= cost - EPSILON/);
  });

  it('always asks for a reason below cost, whoever sells', () => {
    expect(POLICY).toMatch(/Say why you are selling below cost/);
  });

  it('only ever asks for an approval to sell below cost', () => {
    expect(SERVICE).toMatch(/approval_not_needed/);
    expect(withoutComments(SERVICE)).toMatch(/requested >= cost/);
  });

  it('warns the Owner or a Manager before a loss, and refuses anyone else without an approval', () => {
    expect(SALES).toMatch(/mayAcceptLoss \? this\.lossWarnings\(/);
    expect(SALES).toMatch(/!mayAcceptLoss && line\.unitId && line\.cost !== null && line\.price < line\.cost/);
  });

  it('checks per line, never on the sale total', () => {
    /*
     * An aggregate margin check lets a healthy line pay for a ruinous one: a
     * good accessory margin and a phone far below its price still totals
     * positive. The configured price is a decision about one product.
     */
    expect(SALES).toMatch(/for \(const \[index, line\] of prepared\.entries\(\)\)/);
    expect(SALES).toMatch(/assertPriceAllowed/);
  });

  it('uses the same price resolver as the sale', () => {
    // A second way to answer "what does this sell for?" is the divergence
    // `price-resolution.ts` exists to prevent.
    expect(SERVICE).toMatch(/resolveForSaleTx/);
  });
});

describe('who decides a loss', () => {
  it('is the Owner and the Store Manager, by role', () => {
    const holders = Object.entries(ROLE_PERMISSIONS)
      .filter(([, keys]) => keys.includes('sale.below_cost'))
      .map(([role]) => role);
    expect(holders).toEqual(['owner', 'store_manager']);
  });

  it('leaves discount.override (setting a price below cost) with the Owner alone', () => {
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

  it('lets its holder past the approval only, never past the reason', () => {
    const code = withoutComments(POLICY);
    expect(code).toMatch(/if \(!mayAcceptLoss\) \{/);
    expect(code).toMatch(/reason_required/);
  });

  it('requesting needs only the permission to make the sale', () => {
    expect(CONTROLLER).toMatch(/@RequirePermissions\('sale\.create'\)[\s\S]{0,200}request\(/);
  });

  it('deciding needs sale.below_cost', () => {
    expect(CONTROLLER).toMatch(/@RequirePermissions\('sale\.below_cost'\)[\s\S]{0,200}decide\(/);
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
    expect(stale).toMatch(/unitCost/);
    // D223: with no floor, a moved set price is not what was decided.
    expect(withoutComments(stale.slice(0, stale.indexOf('async voidForUnit')))).not.toMatch(/price_changed/);
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
  it('are deduplicated per approval, per event, per person', () => {
    /*
     * The key names the approval and the event, and the database's unique index
     * is `(companyId, targetUserId, dedupeKey)` — so a retried submission or a
     * retried decision cannot produce a second message for anybody.
     */
    expect(SERVICE).toContain("dedupeKey = `discount_approval:${params.approvalId.toString('hex')}:${params.event}`");
    expect(SERVICE).toContain("e.code === 'P2002'");
  });

  it('reach approvers by permission, not by a hardcoded role name', () => {
    expect(SERVICE).toContain("permission: { key: 'sale.below_cost' }");
  });

  it('are addressed to a person and land on the request itself', () => {
    /*
     * The defect this replaced: the service called `NotificationsService.emit`
     * with `{ kind, userId, entityType, entityId }` behind an `as never`, while
     * `emit` takes `{ type, title, targetUserId, actionLink }`. Every field the
     * delivery needed arrived undefined — no type, no recipient, no link — and
     * the cast is what hid it. A notification nobody is addressed by, that opens
     * nothing, is not a notification.
     */
    expect(SERVICE).toContain('targetUserId: userId');
    expect(SERVICE).toContain('type: `discount_approval.${params.event}`');
    expect(SERVICE).toContain("actionLink = `/approvals/${binToUuid(params.approvalId)}`");
  });

  it('carry prices and a flag, never a cost figure', () => {
    // A notification is read outside the request that authorised it, by whoever
    // picks the phone up. Selling prices are the shop's own decisions; the cost
    // is not, and `belowCost` discloses no amount.
    const start = SERVICE.indexOf('private async notify(');
    const notify = SERVICE.slice(start, SERVICE.indexOf('return sent;', start));
    expect(notify).not.toMatch(/unitCost/);
    expect(notify).not.toMatch(/margin/);
  });
});

describe('reading a request', () => {
  it('scopes a requester to their own, on the server', () => {
    /*
     * Anyone with `sale.create` may ask, so anyone with `sale.create` reaches
     * the endpoint. Without this scope they would read every colleague's
     * request and the price each was asking for. A client-side filter is a
     * display preference; this is a boundary.
     */
    expect(SERVICE).toContain("const mineOnly = !this.may('sale.below_cost');");
    expect(SERVICE).toContain('...(mineOnly ? { requesterId: this.tenant.userId() ?? Buffer.alloc(16) } : {}),');
  });

  it('refuses a deep link into another person’s request', () => {
    // A notification's link is a convenience, never an authorisation.
    const get = SERVICE.slice(SERVICE.indexOf('async get(id: string)'));
    expect(get).toContain("if (!this.may('sale.below_cost') && !row.requesterId.equals(");
    expect(get).toContain('ForbiddenException');
  });

  it('gives the Owner the cost through the gate that already governs it', () => {
    /*
     * The approver has to judge a loss, and `docs/46` says they hold
     * `cost.view` already. Naming the field `unitCost` means
     * `CostGatingInterceptor` strips it for everyone else automatically — the
     * same mechanism as the rest of the app, not a second rule to remember.
     */
    expect(SERVICE).toContain('unitCost: Number(row.unitCost),');
    expect(FINANCIAL_FIELDS.has('unitCost')).toBe(true);
  });

  it('names the thing being decided about, in one round trip', () => {
    // An Owner is deciding about a physical phone, in a shop, for a person. Ids
    // would put four more fetches and a spinner in front of that decision.
    expect(SERVICE).toContain('const DETAIL = {');
    expect(SERVICE).toContain('requesterName: row.requester?.name ?? null,');
    expect(SERVICE).toContain('branchName: row.branch?.name ?? null,');
  });
});

describe('the query actually runs', () => {
  it('selects a product by brand and model, because it has no name', () => {
    /*
     * Found live in CP6. Selecting `name` made Prisma refuse the whole query,
     * so BOTH reads of an approval answered 400 "Invalid query parameters" —
     * and every test here passed, because they read the source rather than
     * running it. Pinning the field names is the cheapest guard that survives
     * a schema rename.
     */
    expect(SERVICE).toContain('product: { select: { brand: true, model: true, variant: true } }');
    expect(SERVICE).not.toMatch(/product: \{ select: \{ name: true/);
    const product = SCHEMA.slice(SCHEMA.indexOf('model Product {'));
    const fields = product.slice(0, product.indexOf('\n}'));
    expect(fields).toMatch(/\n  brand\s+String/);
    expect(fields).not.toMatch(/\n  name\s+String/);
  });
});
