// D223 device QA (2026-10-28, second pass): the branch return policy, its snapshot on the sale and the receipt,
// the customer's name, and the Sale lookup — over HTTP against the DISPOSABLE API (port 3999, erp_inv_e2e).
// Fictional data only (test-IMEI bodies, in-store barcodes, invented names). Prints outcomes, never a credential.
//
//   D223_E2E_DIR=<dir with d223-e2e-credentials.json, stores-credentials.json, codes.json> node scripts/d223-policy-journeys.mjs
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = process.env.D223_E2E_DIR ?? tmpdir();
const BASE = 'http://localhost:3999/api/v1';
const MYSQL = process.env.D223_MYSQL ?? 'C:/wamp64/bin/mysql/mysql8.4.7/bin/mysql.exe';
const creds = JSON.parse(readFileSync(join(DIR, 'd223-e2e-credentials.json'), 'utf8'));
const stores = JSON.parse(readFileSync(join(DIR, 'stores-credentials.json'), 'utf8'));
const codes = JSON.parse(readFileSync(join(DIR, 'codes.json'), 'utf8'));
const uuid = (hex) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
const BRANCH = uuid(creds.branchId);
const sql = (q) => execFileSync(MYSQL, ['-h127.0.0.1', '-P3308', '-uroot', '-N', '-B', 'erp_inv_e2e', '-e', q], { encoding: 'utf8' }).trim();

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
async function call(token, method, path, body, branch = BRANCH) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-branch-id': branch, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}
const login = async (c, who) => (await call(null, 'POST', '/auth/login', { identifier: c.personalIds[who], password: c.passwords[who] })).body.accessToken;

const owner = await login(creds, 'owner');
const employee = await login(creds, 'employee');
const other = stores[0];
const otherEmployee = await login(other, 'employee');

// ── 1. A written branch policy ────────────────────────────────────────────
const before = await call(owner, 'GET', '/return-policy');
check('a branch without its own policy reads the company window', before.status === 200 && before.body.ownPolicy === false, JSON.stringify(before.body));
const TEXT_EN = 'Returns only for a manufacturing defect.\nUndamaged, with every original accessory.';
const TEXT_AR = 'نقبل الإرجاع فقط لعيب في التصنيع.\nدون ضرر، ومع كل الملحقات الأصلية.';
const v1 = await call(owner, 'PUT', '/return-policy', { windowHours: 72, textEn: `  ${TEXT_EN}  `, textAr: TEXT_AR, defaultLanguage: 'en' });
check('the Owner writes the branch policy (version 1, text normalised)', v1.status === 200 && v1.body.version === 1 && v1.body.textEn === TEXT_EN, `${v1.status}`);
const markup = await call(owner, 'PUT', '/return-policy', { windowHours: 72, textFr: '<b>non</b>', defaultLanguage: 'en', expectedVersion: 1 });
check('markup is refused, naming the field', markup.status === 400 && markup.body?.code === 'policy_text_markup' && markup.body?.policyField === 'textFr', `${markup.status} ${markup.body?.code}`);

// ── 2–7. Sell a scanned phone to a named customer ─────────────────────────
const [imeiA, imeiB] = codes.seededImei;
const found = await call(owner, 'GET', `/sales/selection/${imeiA}`);
check('the Sale lookup finds the phone in stock as AVAILABLE, with its own product', found.body?.availability === 'available' && found.body?.product?.brand === 'Fictiva', `${found.status} ${found.body?.availability}`);
const customer = await call(owner, 'POST', '/customers', { name: 'Mariem Fictive', phone: '+22200000000' });
check('a fictional customer is added', customer.status === 201, `${customer.status}`);
const sale1 = await call(owner, 'POST', '/sales', {
  clientUuid: randomUUID(),
  lines: [{ identifier: imeiA, price: 11000 }],
  payments: [{ method: 'cash', amount: 11000 }],
  customerId: customer.body.id,
  // An older app still sending a window: accepted, and IGNORED.
  returnWindowHours: 0,
});
check('the sale goes through', sale1.status === 201, `${sale1.status} ${sale1.body?.code ?? ''}`);
check('the response carries the server-resolved policy — the client window was ignored', sale1.body?.returnPolicy?.windowHours === 72 && sale1.body?.returnPolicy?.texts?.en === TEXT_EN, JSON.stringify(sale1.body?.returnPolicy));
check('the response names the customer for the receipt', sale1.body?.customer?.name === 'Mariem Fictive');
const id1 = sale1.body.id;
const hex1 = id1.replace(/-/g, '');
check('MySQL holds the snapshot: window, deadline, texts, language, version, customer',
  sql(`SELECT CONCAT(return_window_hours,'|',return_deadline_at IS NOT NULL,'|',LEFT(return_policy_text_en,22),'|',IFNULL(return_policy_text_fr,'NULL'),'|',return_policy_language,'|',return_policy_version,'|',customer_name_snapshot,'|',IFNULL(return_policy_overridden_by,'none')) FROM sales WHERE id=UNHEX('${hex1}')`) ===
    '72|1|Returns only for a man|NULL|en|1|Mariem Fictive|none');
const detail1 = await call(owner, 'GET', `/sales/${id1}`);
check('the receipt payload names the customer and carries the written conditions', detail1.body?.receiptCustomer?.name === 'Mariem Fictive' && detail1.body?.returnPolicy?.texts?.ar === TEXT_AR);
const leaked = JSON.stringify(detail1.body?.returnPolicy ?? {});
check('the receipt payload has no cost or margin in its policy part', !/cost|margin/i.test(leaked));

// ── 8–10. Change the policy and the customer: the old sale does not move ──
const v2 = await call(employee, 'PUT', '/return-policy', { windowHours: 0, textEn: 'All sales final: tested in front of you.', defaultLanguage: 'en', expectedVersion: 1 });
check("an Employee edits their own branch's policy (version 2)", v2.status === 200 && v2.body.version === 2, `${v2.status} ${v2.body?.code ?? ''}`);
const audits = sql(`SELECT COUNT(*) FROM audit_logs WHERE entity_type='BranchReturnPolicy' AND entity_id=UNHEX('${creds.branchId}')`);
check('both changes are audited, with the actor and both sides', audits === '2' && sql(`SELECT COUNT(DISTINCT user_id) FROM audit_logs WHERE entity_type='BranchReturnPolicy'`) === '2', `rows=${audits}`);
sql(`UPDATE customers SET name='Mariem Renamed' WHERE id=UNHEX('${customer.body.id.replace(/-/g, '')}')`);
const reprint = await call(owner, 'GET', `/sales/${id1}`);
check('a reprint of the old sale keeps its window, its conditions and the customer as named then',
  reprint.body?.returnPolicy?.windowHours === 72 && reprint.body?.returnPolicy?.texts?.en === TEXT_EN && reprint.body?.receiptCustomer?.name === 'Mariem Fictive',
  JSON.stringify({ w: reprint.body?.returnPolicy?.windowHours, c: reprint.body?.receiptCustomer }));
const sale2 = await call(owner, 'POST', '/sales', { clientUuid: randomUUID(), lines: [{ identifier: imeiB, price: 11000 }], payments: [{ method: 'cash', amount: 11000 }] });
check('a new sale carries the new policy, and a cash customer is no name at all',
  sale2.status === 201 && sale2.body?.returnPolicy?.windowHours === 0 && sale2.body?.returnPolicy?.texts?.en === 'All sales final: tested in front of you.' && sale2.body?.returnPolicy?.policyVersion === 2 && sale2.body?.customer === null,
  JSON.stringify(sale2.body?.returnPolicy));

// ── 11. Receive refuses the sold phone; Sale says it is sold ──────────────
const again = await call(owner, 'POST', '/purchases', { clientUuid: randomUUID(), paymentMethod: 'cash', items: [{ productId: found.body?.product?.id ?? sql(`SELECT LOWER(INSERT(INSERT(INSERT(INSERT(HEX(product_id),9,0,'-'),14,0,'-'),19,0,'-'),24,0,'-')) FROM units WHERE imei_primary='${imeiA}'`), unitCost: 9000, units: [{ identifier: imeiA }] }] });
check('Receive refuses the IMEI already registered', (again.body?.rejected ?? []).length === 1 && again.body?.unitsCreated === 0, `${again.status} rejected=${(again.body?.rejected ?? []).length}`);
const scanned = await call(owner, 'POST', '/scan', { code: imeiA });
check('the receiving lookup reports it as already held', scanned.body?.inventory?.alreadyInInventory === true);
const soldLookup = await call(owner, 'GET', `/sales/selection/${imeiA}`);
check('the Sale lookup says it is SOLD — its true state, not a duplicate', soldLookup.body?.availability === 'sold', `${soldLookup.body?.availability}`);

// ── 12. Serial and counted barcode in the Sale lookup ─────────────────────
const serial = await call(owner, 'GET', `/sales/selection/${codes.seededSerials[0]}`);
check('a serial number finds its unit, available', serial.body?.availability === 'available' && serial.body?.matchedBy === 'serial', `${serial.body?.availability} ${serial.body?.matchedBy}`);
const barcode = await call(owner, 'GET', `/sales/selection/${codes.chargerBarcode}`);
check('a counted product’s barcode finds the product with its stock', barcode.body?.kind === 'product' && barcode.body?.quantityAvailable > 0, `${barcode.body?.kind} ${barcode.body?.quantityAvailable}`);

// ── 13–14. Branch and company isolation ───────────────────────────────────
const cross = await call(otherEmployee, 'PUT', '/return-policy', { windowHours: 24, defaultLanguage: 'en' });
check("another company's employee cannot edit this branch's policy", cross.status === 403 || cross.status === 404, `${cross.status}`);
const crossRead = await call(otherEmployee, 'GET', '/return-policy');
check("…nor read it", crossRead.status === 403 || crossRead.status === 404, `${crossRead.status}`);
const own = await call(otherEmployee, 'GET', '/return-policy', undefined, uuid(other.branchId));
check('their own branch is unaffected: no policy of its own yet', own.status === 200 && own.body.ownPolicy === false && own.body.windowHours === 0);

console.log(`\npolicy journeys: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
