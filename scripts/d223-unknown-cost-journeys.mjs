// D223 device QA (2026-10-28): an unknown buying cost, end to end, over HTTP and against real MySQL.
// The DISPOSABLE API (port 3999) on erp_inv_e2e only. Fictional data only; prints outcomes, never a credential or a token.
//
//   node scripts/d223-unknown-cost-journeys.mjs   (after d223-e2e-fixture.ts and d223-journeys.mjs, API on 3999)
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3999/api/v1';
const MYSQL = process.env.D223_MYSQL ?? 'C:/wamp64/bin/mysql/mysql8.4.7/bin/mysql.exe';
const creds = JSON.parse(readFileSync(join(process.env.D223_E2E_DIR ?? tmpdir(), 'd223-e2e-credentials.json'), 'utf8'));
const hex = creds.branchId;
const BRANCH = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
const run = Date.now().toString().slice(-5);

/** One value from the disposable database — never another schema. */
const sql = (query) =>
  execFileSync(MYSQL, ['-h127.0.0.1', '-P3308', '-uroot', '-N', '-B', 'erp_inv_e2e', '-e', query], { encoding: 'utf8' }).trim();

const luhn = (body) => {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let d = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return body + ((10 - (sum % 10)) % 10);
};
const imei = (n) => luhn(`00101003${run}${n}`);

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
const login = async (who) => (await call(null, 'POST', '/auth/login', { identifier: creds.personalIds[who], password: creds.passwords[who] })).body.accessToken;

const owner = await login('owner');
const employee = await login('employee');
await call(owner, 'POST', '/closings/open', { openingMoney: { decision: 'set', cashAmount: 50000 } });
const cats = await call(owner, 'GET', '/categories');
const byKey = Object.fromEntries((cats.body ?? []).filter((c) => c.key).map((c) => [c.key, c]));

// ── The category decides the form (served by the API) ──────────────────────
check('each category says which modes it allows', JSON.stringify(byKey['phones.smartphones']?.allowedTrackingTypes) === '["imei"]' && JSON.stringify(byKey['computers.laptops']?.allowedTrackingTypes) === '["serial","quantity"]');
const audioBrands = await call(owner, 'GET', '/device-catalogue/brands?category=audio.earbuds');
const phoneBrands = await call(owner, 'GET', '/device-catalogue/brands?category=phones.smartphones');
check('the phone catalogue answers under Phones only — nothing for Audio', Array.isArray(audioBrands.body) && audioBrands.body.length === 0 && phoneBrands.body?.length > 0, `audio=${audioBrands.body?.length} phones=${phoneBrands.body?.length}`);
const laptopModels = await call(owner, 'GET', '/device-catalogue/brands/apple/models?category=computers.laptops');
check('Apple under Laptops offers no iPhone', Array.isArray(laptopModels.body) && laptopModels.body.length === 0);

// ── A laptop received without its cost: the product and its unit together ──
const serial = `QA-UC-${run}`;
const laptop = { brand: 'Fictiva', model: `QA Book ${run}`, categoryId: byKey['computers.laptops'].id, trackingType: 'serial', specifications: { processor: 'Core i5', ram: 16 } };
const intake = { clientUuid: randomUUID(), paymentMethod: 'cash', items: [{ newProduct: laptop, units: [{ identifier: serial }] }] };
const first = await call(owner, 'POST', '/purchases', intake);
check('a new product and its unit, received with NO cost, in one request', first.status === 201 && first.body?.unitsCreated === 1 && first.body?.createdProducts?.length === 1, `${first.status}`);
check('the unit cost is NULL in MySQL — not zero', sql(`SELECT IFNULL(cost,'NULL') FROM units WHERE serial_no='${serial}'`) === 'NULL');
check('the purchase line cost is NULL, and nothing was paid for it', sql(`SELECT CONCAT(IFNULL(pi.unit_cost,'NULL'),'|',p.total) FROM purchase_items pi JOIN purchases p ON p.id=pi.purchase_id JOIN units u ON u.purchase_id=p.id WHERE u.serial_no='${serial}'`) === 'NULL|0.00');
const replay = await call(owner, 'POST', '/purchases', intake);
check('an idempotent retry creates one product and one unit', replay.body?.replayed === true && sql(`SELECT COUNT(*) FROM products WHERE model='QA Book ${run}'`) === '1' && sql(`SELECT COUNT(*) FROM units WHERE serial_no='${serial}'`) === '1');
const inStock = await call(owner, 'GET', `/inventory?search=${encodeURIComponent(serial)}`);
const row = (inStock.body?.rows ?? []).find?.((u) => u.identifier === serial);
check('immediately in Stock, saying its cost is missing', Boolean(row) && row.cost === null && row.costMissing === true, row ? `cost=${row.cost} costMissing=${row.costMissing}` : 'not found');
const lookup = await call(owner, 'POST', '/scan', { code: serial });
check('immediately found by a Sale lookup', lookup.body?.inventory?.alreadyInInventory === true, `${lookup.status}`);
const asEmployee = await call(employee, 'GET', `/inventory?search=${encodeURIComponent(serial)}`);
const eRow = (asEmployee.body?.rows ?? []).find?.((u) => u.identifier === serial);
// A Store Employee holds cost.view by role, so sees the status too; a role without it has both stripped (financial-fields spec).
check('an employee sees it in Stock, its cost missing', Boolean(eRow) && eRow.cost === null && eRow.costMissing === true);

// ── Sold before the cost is known: revenue yes, profit incomplete ──────────
const unitId = sql(`SELECT LOWER(CONCAT(SUBSTR(HEX(id),1,8),'-',SUBSTR(HEX(id),9,4),'-',SUBSTR(HEX(id),13,4),'-',SUBSTR(HEX(id),17,4),'-',SUBSTR(HEX(id),21))) FROM units WHERE serial_no='${serial}'`);
const sale = await call(employee, 'POST', '/sales', { clientUuid: randomUUID(), lines: [{ identifier: serial, price: 30000 }], payments: [{ method: 'cash', amount: 30000 }] });
check('an employee sells it with no below-cost question — there is no cost to be below', sale.status === 201, `${sale.status} ${sale.body?.code ?? ''}`);
const saleId = sale.body?.id ?? sale.body?.saleId;
const saleRow = sql(`SELECT CONCAT(IFNULL(si.cost,'NULL'),'|',s.total,'|',s.total_cost,'|',s.margin) FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN units u ON u.id=si.unit_id WHERE u.serial_no='${serial}'`);
check('the sale line cost is NULL; revenue is recorded; the margin claims no profit for it', saleRow === 'NULL|30000.00|0.00|0.00', saleRow);
const rows = sql(`SELECT missing_cost_lines FROM daily_rollups WHERE branch_id=UNHEX('${hex}') ORDER BY day DESC LIMIT 1`);
const dash = await call(owner, 'GET', '/dashboard');
check('the dashboard discloses the sold line of unknown cost', Number(dash.body?.today?.missingCostLines ?? 0) >= 1 || Number(rows || 0) >= 1, `today=${dash.body?.today?.missingCostLines} rollup=${rows}`);

// ── Entering the cost later: audited, the sale's price untouched, no second sale ──
const salesBefore = sql(`SELECT COUNT(*) FROM sales`);
const denied = await call(employee, 'POST', `/units/${unitId}/cost`, { cost: 21000 });
check('an employee cannot enter it', denied.status === 403, `${denied.status}`);
const completed = await call(owner, 'POST', `/units/${unitId}/cost`, { cost: 21000, reason: 'Invoice found' });
check('the Owner enters it later', completed.status === 201 && completed.body?.saleCompleted === true, `${completed.status} ${JSON.stringify(completed.body)}`);
const after = sql(`SELECT CONCAT(u.cost,'|',si.cost,'|',si.price,'|',s.total_cost,'|',s.margin) FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN units u ON u.id=si.unit_id WHERE u.serial_no='${serial}'`);
check('the sale now has its cost and a complete margin; its price is unchanged', after === '21000.00|21000.00|30000.00|21000.00|9000.00', after);
check('no second sale was created', sql(`SELECT COUNT(*) FROM sales`) === salesBefore);
check('the entry is in the audit history with its reason', Number(sql(`SELECT COUNT(*) FROM audit_logs WHERE entity_type='Unit' AND entity_id=UNHEX(REPLACE('${unitId}','-','')) AND reason='Invoice found'`)) === 1);
const again = await call(owner, 'POST', `/units/${unitId}/cost`, { cost: 1 });
check('a known cost cannot be "completed" again', again.status === 409 && again.body?.code === 'cost_known', `${again.status} ${again.body?.code}`);

// ── Counted stock: some pieces of unknown cost ─────────────────────────────
const buds = { brand: 'Fictiva', model: `QA Buds ${run}`, categoryId: byKey['audio.earbuds'].id, trackingType: 'quantity', barcode: `20${run}0000001`.slice(0, 13) };
const known = await call(owner, 'POST', '/purchases', { clientUuid: randomUUID(), paymentMethod: 'cash', items: [{ newProduct: buds, unitCost: 400, quantity: 5 }] });
const productId = known.body?.createdProducts?.[0]?.productId;
const unknown = await call(owner, 'POST', '/purchases', { clientUuid: randomUUID(), paymentMethod: 'cash', items: [{ productId, quantity: 10 }] });
check('10 more pieces received without a cost', unknown.status === 201 && unknown.body?.stockLines === 1, `${unknown.status}`);
check('the stock keeps its known average and counts 10 of unknown cost', sql(`SELECT CONCAT(si.quantity,'|',si.cost,'|',si.missing_cost_quantity) FROM stock_items si JOIN products p ON p.id=si.product_id WHERE p.model='QA Buds ${run}'`) === '15|400.00|10');
const sold = await call(owner, 'POST', '/sales', { clientUuid: randomUUID(), lines: [{ productId, quantity: 3, price: 800 }], payments: [{ method: 'cash', amount: 2400 }] });
check('selling 3 of them: the line is of unknown cost, and they come off the unknown pieces', sold.status === 201 && sql(`SELECT CONCAT(si.quantity,'|',si.missing_cost_quantity) FROM stock_items si JOIN products p ON p.id=si.product_id WHERE p.model='QA Buds ${run}'`) === '12|7', `${sold.status}`);
const missing = await call(owner, 'GET', `/inventory/stock/${productId}/missing-costs`);
const line = missing.body?.lines?.[0];
check('the received line without a cost is listed', missing.body?.missingCostQuantity === 7 && line?.quantity === 10, JSON.stringify(missing.body));
const done = await call(owner, 'POST', `/purchase-items/${line?.id}/cost`, { cost: 500 });
check('entering it values the 7 still here; the 3 sold stay unknown', done.status === 201 && done.body?.piecesValued === 7 && done.body?.piecesSoldUnknown === 3, JSON.stringify(done.body));
check('the average now covers all 12: (5 × 400 + 7 × 500) / 12', sql(`SELECT CONCAT(si.cost,'|',si.missing_cost_quantity) FROM stock_items si JOIN products p ON p.id=si.product_id WHERE p.model='QA Buds ${run}'`) === '458.33|0');

// ── Below cost, where the cost IS known, is unchanged ──────────────────────
const phone = await call(owner, 'POST', '/purchases', { clientUuid: randomUUID(), paymentMethod: 'cash', items: [{ newProduct: { brand: 'Fictiva', model: `QA Phone ${run}`, categoryId: byKey['phones.smartphones'].id, trackingType: 'imei' }, unitCost: 9000, units: [{ identifier: imei(1) }] }] });
const below = await call(employee, 'POST', '/sales', { clientUuid: randomUUID(), lines: [{ identifier: imei(1), price: 8000 }], payments: [{ method: 'cash', amount: 8000 }], overrideReason: 'test' });
check('a known cost: an employee is still refused below it without an approval', phone.status === 201 && below.status === 403 && below.body?.code === 'approval_required', `${below.status} ${below.body?.code}`);

console.log(`\nunknown-cost journeys: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
