// Customer activation OPEN (CUSTOMER_ACTIVATION=open; the owner's pilot decision of 2026-10-29, D224) over HTTP against
// a DISPOSABLE API (port 3998, erp_dv_e2e on 127.0.0.1:3308): what opening it allows and what it never does. A real
// administrator session with its second factor and step-up; fictional data only. Prints outcomes, never a password,
// code or token.
//
//   1. D224_PHASE=seed  — API with CUSTOMER_ACTIVATION=closed and WHATSAPP_CHANNEL=development-log (the only phase in
//      which a public registration can exist, so that a genuinely pending customer exists BEFORE activation opens).
//   2. D224_PHASE=open  — the API restarted with production's switches: CUSTOMER_ACTIVATION=open, WHATSAPP_CHANNEL and
//      EMAIL_CHANNEL disabled, and APP_ENV=staging without STAGING_CONTACT_OUTBOX, so that — as in production, where
//      APP_ENV=production bars it — no development outbox stands in for the disabled channels (contact-delivery.ts
//      `outboxAllowed`). Under plain NODE_ENV=development the outbox takes every channel and a registration succeeds.
//
//   D224_DIR=<dir with secrets.json> D224_PHASE=seed node scripts/d224-activation-journeys.mjs
//   D224_DIR=<dir>                   D224_PHASE=open node scripts/d224-activation-journeys.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { join } from 'node:path';

const DIR = process.env.D224_DIR;
if (!DIR) throw new Error('D224_DIR is required');
const PHASE = process.env.D224_PHASE;
if (PHASE !== 'seed' && PHASE !== 'open') throw new Error('D224_PHASE is seed or open');
const BASE = 'http://localhost:3998/api/v1';
const MYSQL = process.env.D224_MYSQL ?? 'C:/wamp64/bin/mysql/mysql8.4.7/bin/mysql.exe';
const secrets = JSON.parse(readFileSync(join(DIR, 'secrets.json'), 'utf8'));
const statePath = join(DIR, 'activation-state.json');
// mysql.exe on Windows ends its lines with \r: dropped, so that two snapshots compare by value.
const sql = (q) => execFileSync(MYSQL, ['-h127.0.0.1', '-P3308', '-uroot', '-N', '-B', 'erp_dv_e2e', '-e', q], { encoding: 'utf8' }).replace(/\r/g, '').trim();
const hex = (uuid) => uuid.replace(/-/g, '');
const WHATSAPP_CONSENT_VERSION = 'wa-operational-2026-10-19';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`);
};

async function call(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, body: json };
}

// ── TOTP (RFC 6238, SHA-1, 30 s, 6 digits), for the disposable administrator only ──
function base32(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, '0');
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totp(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}
const stepNow = () => Math.floor(Date.now() / 30_000);
let lastStep = 0;
/** A code from a step never used before: the server refuses a replayed step. */
async function freshCode() {
  while (stepNow() <= lastStep) await new Promise((r) => setTimeout(r, 1000));
  lastStep = stepNow();
  return totp(secrets.mfaSecret, lastStep);
}
/** A signed-in administrator session with its second factor — and NO step-up yet. */
async function adminSession() {
  if (!secrets.mfaSecret) throw new Error('the disposable administrator has no enrolled second factor (run d224-deferral-journeys first)');
  const signIn = await call(null, 'POST', '/platform/admin/sign-in', { email: secrets.adminEmail, password: secrets.adminPassword });
  if (signIn.status !== 200) throw new Error(`admin sign-in ${signIn.status}`);
  const token = signIn.body.sessionToken;
  const verify = await call(token, 'POST', '/platform/admin/mfa/verify', { code: await freshCode() });
  if (verify.status !== 200) throw new Error(`mfa verify ${verify.status} ${verify.body?.code ?? ''}`);
  return token;
}
async function stepUp(token) {
  const r = await call(token, 'POST', '/platform/admin/step-up', { password: secrets.adminPassword, code: await freshCode() });
  if (r.status !== 200) throw new Error(`step-up ${r.status} ${r.body?.code ?? ''}`);
}
const confirmPassword = secrets.adminPassword;

const companyCount = () => Number(sql('SELECT COUNT(*) FROM companies'));
const subscriptionOf = (companyHex) =>
  sql(`SELECT CONCAT_WS('|', status, version, IFNULL(current_period_end,'none'), is_complimentary) FROM subscriptions WHERE company_id = UNHEX('${companyHex}')`);
const usersOf = (companyHex) =>
  sql(`SELECT GROUP_CONCAT(CONCAT_WS('|', HEX(id), is_active, phone_verification, IFNULL(phone_verified_at,'none')) ORDER BY id) FROM users WHERE company_id = UNHEX('${companyHex}')`);
const companyRow = (companyHex) => sql(`SELECT CONCAT_WS('|', is_active, is_test) FROM companies WHERE id = UNHEX('${companyHex}')`);
const auditActions = (companyHex, sinceSql = '1970-01-01') =>
  sql(`SELECT IFNULL(GROUP_CONCAT(action ORDER BY created_at, id), '') FROM platform_audit_events WHERE target_id = UNHEX('${companyHex}') AND created_at >= '${sinceSql}'`);
const nowSql = () => sql('SELECT DATE_FORMAT(NOW(6), "%Y-%m-%d %H:%i:%s.%f")');
/** Every subscription's status, version, period and complimentary flag, by company. */
function allSubscriptionsOf(only) {
  const rows = sql("SELECT CONCAT(HEX(company_id), '=', CONCAT_WS('|', status, version, IFNULL(current_period_end,'none'), is_complimentary)) FROM subscriptions");
  const map = Object.fromEntries(rows.split('\n').filter(Boolean).map((l) => l.split('=')));
  return only ? Object.fromEntries(only.map((k) => [k, map[k] ?? 'missing'])) : map;
}
const fictionalPhone = (prefix) => `+222${prefix}${String(Date.now() % 1_000_000).padStart(6, '0')}`.slice(0, 12);

function registration(name, phone) {
  return {
    idempotencyKey: randomUUID(),
    ownerName: 'Pending Owner',
    businessName: name,
    branchName: 'Main Store',
    phone,
    password: `act-${randomUUID()}`,
    language: 'en',
    whatsappConsentVersion: WHATSAPP_CONSENT_VERSION,
    whatsappConsentLocale: 'en',
  };
}

const admin = await adminSession();
await stepUp(admin);

if (PHASE === 'seed') {
  console.log('== seed: customer activation CLOSED; a public registration exists before activation opens');
  const caps = await call(admin, 'GET', '/platform/capabilities');
  check('the API runs with customer activation closed', caps.status === 200);

  // A customer's business from the console is refused while closed — audited, nothing created.
  const before = companyCount();
  const refusedCreate = await call(admin, 'POST', '/platform/businesses', {
    idempotencyKey: randomUUID(),
    ownerName: 'Closed Owner',
    businessName: `Closed Customer ${Date.now().toString(36)}`,
    phone: fictionalPhone('41'),
    language: 'en',
    isTest: false,
    reason: 'D224 activation journey (closed)',
    confirmPassword,
  });
  check('closed: the console refuses a customer business (customer_activation_closed)', refusedCreate.status === 403 && refusedCreate.body?.code === 'customer_activation_closed', `${refusedCreate.status} ${refusedCreate.body?.code ?? ''}`);
  check('closed: nothing was created', companyCount() === before);
  check('closed: the refusal is audited', sql("SELECT COUNT(*) FROM platform_audit_events WHERE action = 'business.create.refused' AND created_at >= NOW(6) - INTERVAL 5 MINUTE") !== '0');

  // A public registration — possible here only because this phase's WhatsApp channel can send a code.
  const name = `Pending Customer ${Date.now().toString(36)}`;
  const reg = await call(null, 'POST', '/auth/register', registration(name, fictionalPhone('42')));
  check('a public registration creates a pending customer business (WhatsApp code pending)', reg.status >= 200 && reg.status < 300, `${reg.status} ${reg.body?.code ?? ''}`);
  const pendingHex = sql(`SELECT HEX(id) FROM companies WHERE name = '${name}'`);
  check('the pending business exists, a customer’s (not a test business)', /^[0-9A-F]{32}$/.test(pendingHex) && companyRow(pendingHex).endsWith('|0'), companyRow(pendingHex));
  const sub = subscriptionOf(pendingHex);
  check('its subscription is pending, with no period', /^pending_activation\|\d+\|none\|0$/.test(sub), sub);

  // Approving it while closed is refused, audited, and changes nothing.
  const uuid = pendingHex.toLowerCase().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  const approve = await call(admin, 'POST', `/platform/businesses/${uuid}/approve`, { months: 1, reason: 'D224 activation journey (closed)', confirmPassword });
  check('closed: approving a customer is refused (customer_activation_closed)', approve.status === 403 && approve.body?.code === 'customer_activation_closed', `${approve.status} ${approve.body?.code ?? ''}`);
  check('closed: the refusal is audited', auditActions(pendingHex).split(',').includes('subscription.approve.refused'), auditActions(pendingHex));
  check('closed: the subscription is unchanged', subscriptionOf(pendingHex) === sub);

  writeFileSync(
    statePath,
    JSON.stringify({ pendingHex, pendingUuid: uuid, subscription: sub, users: usersOf(pendingHex), company: companyRow(pendingHex), all: allSubscriptionsOf(), seededAt: nowSql() }),
  );
} else {
  console.log('== open: customer activation OPEN; WhatsApp and email disabled (production’s switches)');
  const seeded = JSON.parse(readFileSync(statePath, 'utf8'));

  // ── 1. Public self-registration stays closed: refused before anything is saved ──
  const before = companyCount();
  const pub = await call(null, 'POST', '/auth/register', registration(`Public Attempt ${Date.now().toString(36)}`, fictionalPhone('43')));
  check('public registration is refused (503 registration_unavailable)', pub.status === 503 && pub.body?.code === 'registration_unavailable', `${pub.status} ${pub.body?.code ?? ''}`);
  check('public registration saved nothing', companyCount() === before);

  // ── 2. Opening activation activated nothing that already existed ──
  check('the pending business’s subscription is unchanged by the switch', subscriptionOf(seeded.pendingHex) === seeded.subscription, `${subscriptionOf(seeded.pendingHex)} vs ${seeded.subscription}`);
  check('its users are unchanged (active flags, verification)', usersOf(seeded.pendingHex) === seeded.users);
  check('the company row is unchanged', companyRow(seeded.pendingHex) === seeded.company);
  check('no subscription action was recorded for it since the seed', !/subscription\.(approve|set_period|activate_grant|extend|reinstate)(,|$)/.test(auditActions(seeded.pendingHex, seeded.seededAt)), auditActions(seeded.pendingHex, seeded.seededAt));
  const changed = Object.entries(allSubscriptionsOf(Object.keys(seeded.all))).filter(([k, v]) => seeded.all[k] !== v);
  check(`no subscription that existed before the switch changed (${Object.keys(seeded.all).length} checked)`, changed.length === 0, changed.map(([k]) => k.slice(0, 8)).join(','));

  // ── 3. Only an authorised, stepped-up administrator activates ──
  const target = `/platform/businesses/${seeded.pendingUuid}/approve`;
  const anon = await call(null, 'POST', target, { months: 1, reason: 'D224', confirmPassword: 'wrong' });
  check('approve without a session: 401', anon.status === 401, `${anon.status}`);
  const tenant = await call('not-a-token', 'POST', target, { months: 1, reason: 'D224', confirmPassword: 'wrong' });
  check('approve with a bogus bearer: 401', tenant.status === 401, `${tenant.status}`);
  const fresh = await adminSession(); // MFA verified, no step-up on THIS session
  const noStepUp = await call(fresh, 'POST', target, { months: 1, reason: 'D224', confirmPassword });
  check('approve on a session with no step-up: refused (step_up_required)', noStepUp.status === 403 && noStepUp.body?.code === 'step_up_required', `${noStepUp.status} ${noStepUp.body?.code ?? ''}`);
  const noConfirm = await call(admin, 'POST', target, { months: 1, reason: 'D224' });
  check('approve without the password confirmation: refused', noConfirm.status === 403 && noConfirm.body?.code === 'password_confirmation_required', `${noConfirm.status} ${noConfirm.body?.code ?? ''}`);
  const badConfirm = await call(admin, 'POST', target, { months: 1, reason: 'D224', confirmPassword: `${confirmPassword}-x` });
  check('approve with a wrong password confirmation: refused', badConfirm.status === 403 && badConfirm.body?.code === 'password_confirmation_failed', `${badConfirm.status} ${badConfirm.body?.code ?? ''}`);
  check('after every refusal the pending subscription is still unchanged', subscriptionOf(seeded.pendingHex) === seeded.subscription);

  // ── 4. The console creates, sets up and activates an ordinary customer ──
  const since = nowSql();
  const ownerPhone = fictionalPhone('44');
  const created = await call(admin, 'POST', '/platform/businesses', {
    idempotencyKey: randomUUID(),
    ownerName: 'Portal Owner',
    businessName: `Portal Customer ${Date.now().toString(36)}`,
    phone: ownerPhone,
    language: 'fr',
    isTest: false,
    reason: 'D224 activation journey (open)',
    confirmPassword,
  });
  check('open: the console creates an ordinary customer business', created.status === 201 && typeof created.body?.companyId === 'string', `${created.status} ${created.body?.code ?? ''}`);
  const cid = created.body?.companyId;
  const chex = hex(cid ?? '');
  check('it is not a test business', companyRow(chex).endsWith('|0'), companyRow(chex));
  check('created is not activated: the subscription waits, with no period', /^pending_activation\|\d+\|none\|0$/.test(subscriptionOf(chex)), subscriptionOf(chex));
  const invitationToken = created.body?.invitation?.token;
  check('its Owner’s one-time setup invitation is issued with it', typeof invitationToken === 'string' && invitationToken.length > 20);

  const ownerPassword = `own-${randomUUID()}`;
  const accept = await call(null, 'POST', '/platform/owner-invitation/accept', { token: invitationToken, password: ownerPassword });
  check('the Owner spends the invitation and chooses a password (customer, activation open)', accept.status === 200 && accept.body?.next === 'sign_in', `${accept.status} ${accept.body?.code ?? ''}`);
  const replay = await call(null, 'POST', '/platform/owner-invitation/accept', { token: invitationToken, password: `${ownerPassword}-2` });
  check('the invitation is single-use', replay.status >= 400, `${replay.status}`);
  check('setting the password activated nothing', /^pending_activation\|/.test(subscriptionOf(chex)), subscriptionOf(chex));

  const pay = await call(admin, 'POST', `/platform/businesses/${cid}/payments`, {
    amount: '1500',
    paidAt: new Date().toISOString(),
    channel: 'manual',
    reference: 'D224-JOURNEY',
    note: 'fictional payment, disposable database',
    confirm: true,
    confirmPassword,
  });
  check('a customer’s payment is recorded and confirmed (never claimed provider-verified)', pay.status === 201 && pay.body?.providerVerified === false && pay.body?.confirmedAt !== null, `${pay.status} ${pay.body?.code ?? ''}`);

  const approve = await call(admin, 'POST', `/platform/businesses/${cid}/approve`, { months: 1, reason: 'D224 activation journey: paid', confirmPassword });
  check('approval with a fresh step-up activates it for a paid month', approve.status === 200 && approve.body?.status === 'activated' && typeof approve.body?.periodEnd === 'string', `${approve.status} ${approve.body?.code ?? ''}`);
  const periodEnd = new Date(Date.now() + 45 * 86_400_000).toISOString();
  const period = await call(admin, 'POST', `/platform/businesses/${cid}/period`, { periodEnd, reason: 'D224 activation journey: the paid period', confirmPassword });
  check('the console sets the access period', period.status === 200 && period.body?.periodEnd?.slice(0, 10) === periodEnd.slice(0, 10), `${period.status} ${period.body?.code ?? ''}`);
  check('the subscription is activated with that period', new RegExp(`^activated\\|\\d+\\|${periodEnd.slice(0, 10)}`).test(subscriptionOf(chex)), subscriptionOf(chex));

  const personalId = sql(`SELECT personal_id FROM users WHERE company_id = UNHEX('${chex}') LIMIT 1`);
  const login = await call(null, 'POST', '/auth/login', { identifier: personalId, password: ownerPassword });
  check('the Owner signs in to the activated business', login.status === 200 || login.status === 201, `${login.status} ${login.body?.code ?? ''}`);

  // ── 5. Audited ──
  const actions = auditActions(chex, since).split(',');
  for (const a of ['business.create', 'owner_invitation.issue', 'owner_invitation.accept', 'payment.record_and_confirm', 'subscription.approve', 'subscription.set_period']) {
    check(`audited: ${a}`, actions.includes(a), actions.join(','));
  }
  const leak = sql(`SELECT COUNT(*) FROM platform_audit_events WHERE created_at >= '${since}' AND (CAST(before_state AS CHAR) LIKE '%${invitationToken}%' OR CAST(after_state AS CHAR) LIKE '%${invitationToken}%' OR CAST(after_state AS CHAR) LIKE '%${ownerPassword}%')`);
  check('no token or password in the audit', leak === '0');
}

console.log(`\n${PHASE}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
