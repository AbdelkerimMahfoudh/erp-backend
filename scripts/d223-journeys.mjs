// D223 end-to-end journeys against the DISPOSABLE API (port 3999, erp_inv_e2e).
// Fictional data only: IMEIs are synthetic ("00" test reporting body) with a valid check digit; prices are invented.
// Prints outcomes only — never a credential, a token or a full IMEI.
//
//   node scripts/d223-journeys.mjs   (after d223-e2e-fixture.ts, with the API on port 3999 against erp_inv_e2e)
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3999/api/v1';
const creds = JSON.parse(readFileSync(join(process.env.D223_E2E_DIR ?? tmpdir(), 'd223-e2e-credentials.json'), 'utf8'));
const hex = creds.branchId;
const BRANCH = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

const luhn = (body) => {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let d = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return body + ((10 - (sum % 10)) % 10);
};
const run = Date.now().toString().slice(-6);
// 8 + 5 + 1 = 14 digits before the check digit, so each n is its own phone.
const imei = (n) => luhn(`00101001${run.slice(-5)}${n}`);
const last4 = (v) => `…${String(v).slice(-4)}`;

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function call(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-branch-id': BRANCH, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}

async function login(who) {
  const r = await call(null, 'POST', '/auth/login', { identifier: creds.personalIds[who], password: creds.passwords[who] });
  if (r.status >= 300) throw new Error(`login ${who}: ${r.status} ${r.body?.code ?? ''} ${r.body?.message ?? ''}`);
  return r.body.accessToken;
}

const owner = await login('owner');
const manager = await login('manager');
const employee = await login('employee');
check('owner, manager and employee sign in', Boolean(owner && manager && employee));

// The day must be open before anything is received or sold.
// A fictional drawer amount: the Owner must choose explicitly.
const opened = await call(owner, 'POST', '/closings/open', { openingMoney: { decision: 'set', cashAmount: 50000 } });
check('the business day opens', opened.status < 300 || opened.status === 409, `${opened.status} ${opened.body?.code ?? ''}`);

// ── Categories ────────────────────────────────────────────────────────────
const cats = await call(owner, 'GET', '/categories');
const byKey = Object.fromEntries((cats.body ?? []).filter((c) => c.key).map((c) => [c.key, c]));
check('61 built-in categories, each with its key', Object.keys(byKey).length === 61, `${Object.keys(byKey).length}`);
check('subcategories name their parent', byKey['phones.smartphones']?.parentId === byKey['phones']?.id);

const sub = await call(owner, 'POST', '/categories', { name: `Refurbished ${run}`, defaultTrackingType: 'imei', parentId: byKey['phones'].id });
check('a shop subcategory under Phones (IMEI) is created', sub.status === 201, `${sub.status}`);
const badSub = await call(owner, 'POST', '/categories', { name: `Bulk phones ${run}`, defaultTrackingType: 'quantity', parentId: byKey['phones'].id });
check('a counted subcategory under Phones is refused', badSub.body?.code === 'category_mode_not_allowed', `${badSub.status} ${badSub.body?.code}`);
const grand = await call(owner, 'POST', '/categories', { name: `Grandchild ${run}`, defaultTrackingType: 'imei', parentId: byKey['phones.smartphones'].id });
check('a third level is refused', grand.body?.code === 'category_depth', `${grand.status} ${grand.body?.code}`);
const rename = await call(owner, 'PATCH', `/categories/${byKey['cables'].id}`, { name: 'Wires' });
check('a built-in cannot be renamed', rename.body?.code === 'builtin_category_fixed', `${rename.status} ${rename.body?.code}`);
const dupe = await call(owner, 'POST', '/categories', { name: `Refurbished ${run}`, defaultTrackingType: 'imei' });
check('a duplicate own name is a clear conflict', dupe.body?.code === 'category_name_taken', `${dupe.status} ${dupe.body?.code}`);

// ── Atomic intake: product + stock in one request ─────────────────────────
const phone = { brand: 'Fictiva', model: `Test Phone ${run}`, variant: '128GB Grey', categoryId: byKey['phones.smartphones'].id, trackingType: 'imei' };
const cable = { brand: 'Fictiva', model: `USB-C Cable ${run}`, categoryId: byKey['cables.usbc'].id, trackingType: 'quantity' };
const A = imei(1), B = imei(2), C = imei(3);
const intake = { clientUuid: randomUUID(), paymentMethod: 'cash', items: [
  { newProduct: phone, unitCost: 900, units: [{ identifier: A }, { identifier: B }, { identifier: C }] },
  { newProduct: cable, unitCost: 2, quantity: 10 },
] };
const first = await call(owner, 'POST', '/purchases', intake);
check('one request creates two products, three phones and ten cables', first.status === 201 && first.body?.unitsCreated === 3 && first.body?.stockLines === 1 && first.body?.createdProducts?.length === 2,
  `${first.status} units=${first.body?.unitsCreated} lines=${first.body?.stockLines} created=${first.body?.createdProducts?.length} ${first.body?.message ?? ''}`);
const phoneId = first.body?.createdProducts?.find((p) => p.model === phone.model)?.productId;

const replay = await call(owner, 'POST', '/purchases', intake);
check('the same request replays: same purchase, nothing created twice', replay.body?.replayed === true && replay.body?.purchaseId === first.body?.purchaseId && replay.body?.createdProducts?.length === 2,
  `${replay.status} replayed=${replay.body?.replayed}`);

const changed = await call(owner, 'POST', '/purchases', { ...intake, items: [{ ...intake.items[0], newProduct: { ...phone, variant: '256GB Grey' } }, intake.items[1]] });
check('the same request id with a different product is a conflict', changed.status === 409, `${changed.status}`);

const again = await call(owner, 'POST', '/purchases', { clientUuid: randomUUID(), paymentMethod: 'cash', items: [{ newProduct: phone, unitCost: 900, units: [{ identifier: imei(4) }] }] });
check('creating an existing product again is refused with its id', again.body?.code === 'product_exists' && again.body?.productId === phoneId, `${again.status} ${again.body?.code}`);

const refusedAll = await call(owner, 'POST', '/purchases', { clientUuid: randomUUID(), paymentMethod: 'cash', items: [
  { newProduct: { ...phone, model: `Never Created ${run}` }, unitCost: 900, units: [{ identifier: A }] },
] });
const ghost = await call(owner, 'GET', `/products?active=all&q=${encodeURIComponent(`Never Created ${run}`)}`);
check('every line refused: nothing written, no product-only success', refusedAll.body?.purchaseId === null && (refusedAll.body?.createdProducts ?? []).length === 0 && (ghost.body?.rows ?? []).length === 0,
  `purchaseId=${refusedAll.body?.purchaseId} refusedPhone=${last4(A)} productsFound=${(ghost.body?.rows ?? []).length}`);

const empIntake = await call(employee, 'POST', '/purchases', { clientUuid: randomUUID(), paymentMethod: 'cash', items: [{ newProduct: { ...phone, model: `Employee Phone ${run}` }, unitCost: 900, units: [{ identifier: imei(5) }] }] });
check('an employee cannot create a product through intake', empIntake.status === 403, `${empIntake.status} ${empIntake.body?.code ?? ''}`);

const mistyped = await call(owner, 'POST', '/purchases', { clientUuid: randomUUID(), paymentMethod: 'cash', items: [{ newProduct: { brand: 'Fictiva', model: `Serial TV ${run}`, categoryId: byKey['other'].id, trackingType: 'serial' }, unitCost: 100, identifiers: [`${imei(6).slice(0, 14)}${(Number(imei(6).slice(14)) + 1) % 10}`] }] });
check('a 15-digit serial failing the IMEI check is refused at intake', mistyped.body?.purchaseId === null && /mistyped IMEI/.test(mistyped.body?.rejected?.[0]?.reason ?? ''), `${mistyped.body?.rejected?.[0]?.reason ?? mistyped.status}`);

// ── Stock by category ─────────────────────────────────────────────────────
const phonesStock = await call(owner, 'GET', `/inventory?categoryId=${byKey['phones'].id}&limit=50`);
const cablesStock = await call(owner, 'GET', `/inventory?categoryId=${byKey['cables'].id}&limit=50`);
check('stock filtered by Phones includes its subcategory\'s phones only', (phonesStock.body?.rows ?? []).filter((r) => r.kind === 'unit').length >= 3 && (phonesStock.body?.rows ?? []).every((r) => r.kind === 'unit'),
  `${(phonesStock.body?.rows ?? []).length} rows`);
check('stock filtered by Cables shows the counted cables', (cablesStock.body?.rows ?? []).some((r) => r.kind === 'stock'), `${(cablesStock.body?.rows ?? []).length} rows`);

// ── Selling: no floor, a guarded loss ─────────────────────────────────────
const sale = (identifier, price, extra = {}) => ({ clientUuid: randomUUID(), lines: [{ identifier, price }], payments: [{ method: 'cash', amount: price }], ...extra });

const profit = await call(employee, 'POST', '/sales', sale(A, 950));
check('an employee sells at a profit with no price set and no approval', profit.status === 201, `${profit.status} ${profit.body?.code ?? profit.body?.status ?? ''}`);

const empLoss = await call(employee, 'POST', '/sales', sale(B, 600, { overrideReason: 'display unit' }));
check('an employee is refused below cost without an approval', empLoss.body?.code === 'approval_required', `${empLoss.status} ${empLoss.body?.code}`);

const unitB = await call(owner, 'GET', `/units/${B}`);
const ask = await call(employee, 'POST', '/discount-approvals', { unitId: unitB.body?.id, requestedPrice: 600, reason: 'display unit', clientUuid: randomUUID() });
check('the employee asks for the below-cost price', ask.status === 201, `${ask.status} ${ask.body?.code ?? ''} ${JSON.stringify(ask.body?.message ?? '')}`);
const decided = await call(manager, 'POST', `/discount-approvals/${ask.body?.id}/decide`, { approve: true, expectedVersion: ask.body?.version ?? 0 });
check('a Store Manager approves it', decided.status < 300, `${decided.status} ${decided.body?.code ?? decided.body?.message ?? ''}`);
const approvedSale = await call(employee, 'POST', '/sales', sale(B, 600, { overrideReason: 'display unit' }));
check('the employee then sells at the approved price', approvedSale.status === 201, `${approvedSale.status} ${approvedSale.body?.code ?? ''}`);

const lossSale = sale(C, 500, { overrideReason: 'water damage' });
const warned = await call(manager, 'POST', '/sales', lossSale);
const warning = warned.body?.warnings?.find((w) => w.code === 'loss.below_cost');
check('a manager below cost is warned first, nothing written', warned.body?.status === 'warnings_pending' && warning?.messageKey === 'warning.loss.belowCost' && warning?.reference?.amount === null,
  `${warned.status} ${warned.body?.status}`);
// The SAME request, with the acknowledgement: a confirmation is bound to the payload it was given for.
const done = await call(manager, 'POST', '/sales', { ...lossSale, acknowledgementToken: warned.body?.acknowledgementToken });
check('after acknowledging, the manager sells at a loss with a reason', done.status === 201 && done.body?.status !== 'warnings_pending' && Boolean(done.body?.id ?? done.body?.saleId), `${done.status} ${done.body?.code ?? done.body?.status ?? done.body?.message ?? ''}`);

console.log(`\njourneys: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
