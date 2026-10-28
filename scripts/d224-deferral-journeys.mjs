// D224 (deferred WhatsApp verification, 0109) over HTTP against a DISPOSABLE API (port 3998, erp_dv_e2e) with
// PHONE_VERIFICATION_DEFERRAL=on: a real administrator session with its second factor and step-up, the console's
// provisioning, setup codes spent through the app's door, the staff signing in, and what their roles, stores and
// unverified numbers allow. Fictional data only. Prints outcomes, never a password, code or token.
//
//   D224_DIR=<dir with secrets.json> node scripts/d224-deferral-journeys.mjs           (switch on)
//   D224_DIR=<dir> D224_PHASE=off node scripts/d224-deferral-journeys.mjs              (after a restart with it off)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { join } from 'node:path';

const DIR = process.env.D224_DIR;
if (!DIR) throw new Error('D224_DIR is required');
const PHASE = process.env.D224_PHASE ?? 'on';
const BASE = 'http://localhost:3998/api/v1';
const MYSQL = process.env.D224_MYSQL ?? 'C:/wamp64/bin/mysql/mysql8.4.7/bin/mysql.exe';
const secrets = JSON.parse(readFileSync(join(DIR, 'secrets.json'), 'utf8'));
const statePath = join(DIR, 'journey-state.json');
const sql = (q) => execFileSync(MYSQL, ['-h127.0.0.1', '-P3308', '-uroot', '-N', '-B', 'erp_dv_e2e', '-e', q], { encoding: 'utf8' }).trim();
const hex = (uuid) => uuid.replace(/-/g, '');

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`);
};

async function call(token, method, path, body, branch) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(branch ? { 'x-branch-id': branch } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
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
async function freshCode(secret) {
  while (stepNow() <= lastStep) await new Promise((r) => setTimeout(r, 1000));
  lastStep = stepNow();
  return totp(secret, lastStep);
}

async function adminSession() {
  const signIn = await call(null, 'POST', '/platform/admin/sign-in', { email: secrets.adminEmail, password: secrets.adminPassword });
  if (signIn.status !== 200) throw new Error(`admin sign-in ${signIn.status}`);
  const token = signIn.body.sessionToken;
  if (!secrets.mfaSecret) {
    const start = await call(token, 'POST', '/platform/admin/mfa/enrolment/start', { enrolmentToken: secrets.enrolmentToken });
    if (start.status !== 200) throw new Error(`enrolment start ${start.status} ${start.body?.code ?? ''}`);
    secrets.mfaSecret = start.body.secret;
    writeFileSync(join(DIR, 'secrets.json'), JSON.stringify(secrets));
    const confirm = await call(token, 'POST', '/platform/admin/mfa/enrolment/confirm', { code: await freshCode(secrets.mfaSecret) });
    if (confirm.status !== 200) throw new Error(`enrolment confirm ${confirm.status} ${confirm.body?.code ?? ''}`);
  } else {
    const verify = await call(token, 'POST', '/platform/admin/mfa/verify', { code: await freshCode(secrets.mfaSecret) });
    if (verify.status !== 200) throw new Error(`mfa verify ${verify.status} ${verify.body?.code ?? ''}`);
  }
  return token;
}
async function stepUp(token) {
  const r = await call(token, 'POST', '/platform/admin/step-up', { password: secrets.adminPassword, code: await freshCode(secrets.mfaSecret) });
  if (r.status !== 200) throw new Error(`step-up ${r.status} ${r.body?.code ?? ''}`);
}
const confirmPassword = () => secrets.adminPassword;

async function signIn(personalId, password) {
  const r = await call(null, 'POST', '/auth/login', { identifier: personalId, password });
  return r;
}
const personalIdOf = (userId) => sql(`SELECT personal_id FROM users WHERE id = UNHEX('${hex(userId)}')`);

const admin = await adminSession();
await stepUp(admin);

if (PHASE === 'on') {
  const deferral = { reason: 'Controlled store pilot: WhatsApp Business API not live yet', confirmControlledTest: true, reviewAt: new Date(Date.now() + 7 * 86_400_000).toISOString() };
  const caps = await call(admin, 'GET', '/platform/capabilities');
  check('the console is told deferral is available (switch on)', caps.body?.phoneVerificationDeferral === true);

  // ── 1. A Test business with a deferred Owner ──
  const key = randomUUID();
  const created = await call(admin, 'POST', '/platform/businesses', {
    idempotencyKey: key,
    ownerName: 'Pilot Owner',
    businessName: `Pilot Electronics ${Date.now().toString(36)}`,
    phone: `+2224${String(Date.now() % 10_000_000).padStart(7, '0')}`,
    language: 'fr',
    isTest: true,
    reason: 'D224 journey',
    verification: 'deferred_by_platform',
    deferral,
    confirmPassword: confirmPassword(),
  });
  check('creates a Test business with a deferred Owner: a setup code, no setup invitation', created.status === 201 && created.body?.setupCode?.delivery === 'manual' && created.body?.invitation === null, `${created.status} ${created.body?.code ?? ''}`);
  const companyId = created.body.companyId;
  check('the Owner is deferred in the database: no verified timestamp', sql(`SELECT CONCAT(phone_verification,'|',IFNULL(phone_verified_at,'null')) FROM users WHERE company_id = UNHEX('${hex(companyId)}')`) === 'deferred_by_platform|null');

  const grant = await call(admin, 'POST', `/platform/businesses/${companyId}/activate-grant`, { days: 30, reason: 'Pilot access', confirmPassword: confirmPassword() });
  check('the Test business is given access by grant', grant.status === 200, `${grant.status} ${grant.body?.code ?? ''}`);
  const annex = await call(admin, 'POST', `/platform/businesses/${companyId}/stores`, { name: 'Annex', reason: 'Second pilot store', confirmPassword: confirmPassword() });
  check('a second store is opened under the grant', annex.status === 200 || annex.status === 201, `${annex.status} ${annex.body?.code ?? ''}`);
  const detail = await call(admin, 'GET', `/platform/businesses/${companyId}`);
  const main = detail.body.branches.find((b) => b.name !== 'Annex').id;
  const second = detail.body.branches.find((b) => b.name === 'Annex').id;

  // ── 2. Test staff ──
  const staff = async (name, role, branchIds, deferred) =>
    call(admin, 'POST', `/platform/businesses/${companyId}/test-staff`, {
      name,
      phone: `+2223${String((Date.now() + name.length * 7919) % 10_000_000).padStart(7, '0')}`,
      role,
      branchIds,
      verification: deferred ? 'deferred_by_platform' : 'required',
      ...(deferred ? { deferral } : {}),
      confirmPassword: confirmPassword(),
    });
  const manager = await staff('Pilot Manager', 'store_manager', [main, second], true);
  const employee = await staff('Pilot Employee', 'store_employee', [main], true);
  const waiting = await staff('Pilot Required', 'store_employee', [main], false);
  check('provisions a deferred Manager (both stores) and a deferred Employee (main store)', manager.status === 201 && employee.status === 201, `${manager.status} ${employee.status} ${manager.body?.code ?? ''} ${employee.body?.code ?? ''}`);
  check('provisions a Required Employee', waiting.status === 201 && waiting.body?.user?.phoneVerification === 'required');
  const noConfirm = await call(admin, 'POST', `/platform/businesses/${companyId}/test-staff`, { name: 'X', phone: '+22239999999', role: 'store_employee', branchIds: [main], verification: 'deferred_by_platform', deferral });
  check('refuses without the password confirmation (step-up)', noConfirm.status === 403, `${noConfirm.status}`);
  const noReason = await call(admin, 'POST', `/platform/businesses/${companyId}/test-staff`, { name: 'Y', phone: '+22239999998', role: 'store_employee', branchIds: [main], verification: 'deferred_by_platform', deferral: { reason: '', confirmControlledTest: true }, confirmPassword: confirmPassword() });
  check('refuses a deferral without a written reason', noReason.status === 400, `${noReason.status}`);
  const spoof = await call(admin, 'POST', `/platform/businesses/${companyId}/test-staff`, { name: 'Z', phone: '+22239999997', role: 'store_employee', branchIds: [main], verification: 'verified', confirmPassword: confirmPassword() });
  check('a console request cannot ask for "verified"', spoof.status === 400, `${spoof.status}`);

  // A customer business (not Test): deferral refused.
  const customerId = randomUUID();
  sql(`INSERT INTO companies (id, name, settings, updated_at, public_store_id) VALUES (UNHEX('${hex(customerId)}'), 'Customer Shop D224', JSON_OBJECT(), NOW(6), 'CU${Date.now().toString(36).toUpperCase().slice(-8)}')`);
  const customer = await call(admin, 'POST', `/platform/businesses/${customerId}/test-staff`, { name: 'C', phone: '+22239999996', role: 'store_employee', branchIds: [main], verification: 'deferred_by_platform', deferral, confirmPassword: confirmPassword() });
  check('refuses for a customer (non-Test) business', customer.status === 403 && customer.body?.code === 'test_business_only', `${customer.status} ${customer.body?.code}`);

  // Public registration cannot carry the field.
  const pub = await call(null, 'POST', '/auth/register', { verification: 'deferred_by_platform', phoneVerification: 'deferred_by_platform' });
  check('public registration rejects the field', pub.status === 400 && /should not exist/.test(JSON.stringify(pub.body)), `${pub.status}`);

  // ── 3. No WhatsApp anything ──
  const numbers = sql(`SELECT GROUP_CONCAT(phone) FROM users WHERE company_id = UNHEX('${hex(companyId)}')`).split(',');
  const inList = numbers.map((n) => `'${n}'`).join(',');
  check('no verification code was created for any provisioned number', sql(`SELECT COUNT(*) FROM contact_verifications WHERE destination IN (${inList})`) === '0');
  check('no WhatsApp consent was recorded for the business', sql(`SELECT COUNT(*) FROM whatsapp_consents WHERE actor_company_id = UNHEX('${hex(companyId)}')`) === '0');
  check('no verified timestamp anywhere in the business', sql(`SELECT COUNT(*) FROM users WHERE company_id = UNHEX('${hex(companyId)}') AND phone_verified_at IS NOT NULL`) === '0');

  // ── 4. Setup codes, through the app's own door ──
  const PW = { owner: `own-${randomUUID()}`, manager: `mgr-${randomUUID()}`, employee: `emp-${randomUUID()}`, waiting: `req-${randomUUID()}` };
  const spend = (token, password) => call(null, 'POST', '/auth/owner-setup', { token, password });
  const [a, b] = await Promise.all([spend(created.body.setupCode.token, PW.owner), spend(created.body.setupCode.token, `${PW.owner}-x`)]);
  check('the Owner’s code spent twice at once: exactly one wins', [a.status, b.status].sort().join() === '200,400', `${a.status} ${b.status}`);
  const ownerPw = a.status === 200 ? PW.owner : `${PW.owner}-x`;
  check('the Manager and Employee spend their own codes', (await spend(manager.body.setupCode.token, PW.manager)).status === 200 && (await spend(employee.body.setupCode.token, PW.employee)).status === 200);
  const again = await spend(employee.body.setupCode.token, 'another-password-1');
  check('a spent code is refused with the generic answer', again.status === 400 && again.body?.message === 'That invitation cannot be used.');
  await spend(waiting.body.setupCode.token, PW.waiting);

  // ── 5. Sign-in, multi-session, the state as the app reads it ──
  const ownerId = sql(`SELECT LOWER(INSERT(INSERT(INSERT(INSERT(HEX(id),9,0,'-'),14,0,'-'),19,0,'-'),24,0,'-')) FROM users WHERE company_id = UNHEX('${hex(companyId)}') ORDER BY created_at LIMIT 1`);
  const o1 = await signIn(personalIdOf(ownerId), ownerPw);
  const o2 = await signIn(personalIdOf(ownerId), ownerPw);
  const m = await signIn(personalIdOf(manager.body.user.id), PW.manager);
  const e = await signIn(personalIdOf(employee.body.user.id), PW.employee);
  check('the deferred Owner, Manager and Employee sign in', [o1, o2, m, e].every((r) => r.status === 200 && r.body?.accessToken), [o1, o2, m, e].map((r) => `${r.status}:${r.body?.code ?? ''}`).join(' '));
  const w = await signIn(personalIdOf(waiting.body.user.id), PW.waiting);
  check('the Required Employee cannot sign in until their number is verified', w.status === 401, `${w.status}`);
  const OT = o1.body.accessToken;
  const ET = e.body.accessToken;
  const MT = m.body.accessToken;
  const meE = await call(ET, 'GET', '/auth/me');
  check('/auth/me says deferred_by_platform, a test business', meE.body?.phoneVerification === 'deferred_by_platform' && meE.body?.isTestBusiness === true);
  const accE = await call(ET, 'GET', '/account');
  check('the account says not verified, deferred', accE.body?.whatsappVerified === false && accE.body?.phoneVerification === 'deferred_by_platform' && accE.body?.phoneVerifiedAt === null);

  // ── 6. Roles and stores still apply ──
  const usersE = await call(ET, 'GET', '/users', undefined, main);
  const usersO = await call(OT, 'GET', '/users', undefined, main);
  check('an Employee cannot manage users; the Owner can', usersE.status === 403 && usersO.status === 200, `${usersE.status} ${usersO.status}`);
  const ownStore = await call(ET, 'GET', '/sales/selection/001010019000999', undefined, main);
  const otherStore = await call(ET, 'GET', '/sales/selection/001010019000999', undefined, second);
  const managerAnnex = await call(MT, 'GET', '/sales/selection/001010019000999', undefined, second);
  check('the Employee works in their store and is refused in the other', ownStore.status !== 403 && otherStore.status === 403, `${ownStore.status} ${otherStore.status}`);
  check('the Manager works in both of their stores', managerAnnex.status !== 403, `${managerAnnex.status}`);

  // ── 7. WhatsApp-dependent actions stay unavailable ──
  const del = await call(ET, 'POST', '/account/deletion/request', { password: PW.employee, clientUuid: randomUUID() });
  // Refused before any code: delivery is off here (as in production), and an unverified number is refused right after.
  check('a WhatsApp-dependent action (deletion code) is refused, and nothing is opened', (del.status === 503 && del.body?.code === 'deletion_unavailable') || (del.status === 409 && del.body?.code === 'whatsapp_number_required'), `${del.status} ${del.body?.code}`);
  check('…no deletion request exists for the deferred person', sql(`SELECT COUNT(*) FROM account_deletion_requests WHERE user_id = UNHEX('${hex(employee.body.user.id)}')`) === '0');

  // ── 8. Sessions are separate ──
  await call(OT, 'POST', '/auth/logout', { refreshToken: o1.body.refreshToken });
  const stillO2 = await call(o2.body.accessToken, 'GET', '/auth/me');
  check('signing one Owner session out leaves the other working', stillO2.status === 200, `${stillO2.status}`);
  const meM = await call(MT, 'GET', '/auth/me');
  check('each session is its own person', meM.body?.id === manager.body.user.id && meE.body?.id === employee.body.user.id);

  // ── 9. The pilot mark ──
  const pilot = await call(admin, 'POST', `/platform/businesses/${companyId}/pilot-status`, { isPilot: true, reason: 'Store pilot', confirmPassword: confirmPassword() });
  const meP = await call(MT, 'GET', '/auth/me');
  check('the pilot mark reaches the app', pilot.status === 200 && meP.body?.isPilotBusiness === true, `${pilot.status}`);
  const pilotCustomer = await call(admin, 'POST', `/platform/businesses/${customerId}/pilot-status`, { isPilot: true, reason: 'x', confirmPassword: confirmPassword() });
  check('a customer business cannot be a pilot', pilotCustomer.status === 403, `${pilotCustomer.status}`);

  // ── 10. Lifecycle ──
  const list = await call(admin, 'GET', `/platform/phone-verification/deferred?businessId=${companyId}`);
  check('the console lists the three deferred accounts, never as verified', list.body?.accounts?.length === 3 && !/"verified"/.test(JSON.stringify(list.body)), `${list.body?.accounts?.length}`);
  const filtered = await call(admin, 'GET', '/platform/businesses?verification=deferred');
  check('the businesses list filters to deferred verification', filtered.body?.rows?.some((r) => r.id === companyId) && !filtered.body?.rows?.some((r) => r.id === customerId));
  const cross = await call(admin, 'POST', `/platform/businesses/${customerId}/accounts/${employee.body.user.id}/require-verification`, { reason: 'x', confirmPassword: confirmPassword() });
  check('another business’s address finds nobody', cross.status === 404, `${cross.status}`);
  const req = await call(admin, 'POST', `/platform/businesses/${companyId}/accounts/${employee.body.user.id}/require-verification`, { reason: 'WhatsApp API ready', confirmPassword: confirmPassword() });
  const meR = await call(ET, 'GET', '/auth/me');
  check('deferred → required: nothing sent, the state moves, the session stays', req.body?.sent === 'nothing' && meR.body?.phoneVerification === 'required' && sql(`SELECT COUNT(*) FROM contact_verifications WHERE destination IN (${inList})`) === '0');
  const cancel = await call(admin, 'POST', `/platform/businesses/${companyId}/accounts/${waiting.body.user.id}/cancel`, { reason: 'Left the pilot', confirmPassword: confirmPassword() });
  check('a provisioned account is cancelled', cancel.status === 200 && sql(`SELECT deleted_at IS NOT NULL FROM users WHERE id = UNHEX('${hex(waiting.body.user.id)}')`) === '1');

  // ── 11. The audit ──
  const actions = sql(`SELECT GROUP_CONCAT(DISTINCT action ORDER BY action) FROM platform_audit_events WHERE target_id = UNHEX('${hex(companyId)}')`);
  for (const a of ['account.create', 'account.cancel', 'account_setup_code.issue', 'account_setup_code.use', 'account_setup_code.refused', 'phone_verification.defer', 'phone_verification.require', 'business.pilot_status']) {
    check(`audited: ${a}`, actions.split(',').includes(a), actions);
  }
  check('refusals are audited too', sql(`SELECT COUNT(*) FROM platform_audit_events WHERE target_id = UNHEX('${hex(customerId)}') AND action LIKE '%.refused'`) !== '0');
  const leak = sql(`SELECT COUNT(*) FROM platform_audit_events WHERE target_id = UNHEX('${hex(companyId)}') AND (after_state LIKE '%${created.body.setupCode.token}%' OR after_state LIKE '%${PW.employee}%')`);
  check('no code or password in the audit', leak === '0');

  writeFileSync(statePath, JSON.stringify({ companyId, main, kept: manager.body.user.id }));
} else {
  // ── The kill switch off (the API restarted with PHONE_VERIFICATION_DEFERRAL=off) ──
  if (!existsSync(statePath)) throw new Error('run the "on" phase first');
  const st = JSON.parse(readFileSync(statePath, 'utf8'));
  const caps = await call(admin, 'GET', '/platform/capabilities');
  check('switch off: the console is told deferral is unavailable', caps.body?.phoneVerificationDeferral === false);
  const refused = await call(admin, 'POST', `/platform/businesses/${st.companyId}/test-staff`, {
    name: 'After switch-off',
    phone: '+22238888888',
    role: 'store_employee',
    branchIds: [st.main],
    verification: 'deferred_by_platform',
    deferral: { reason: 'x', confirmControlledTest: true },
    confirmPassword: confirmPassword(),
  });
  check('switch off: a new deferral is refused at the API', refused.status === 403 && refused.body?.code === 'deferral_disabled', `${refused.status} ${refused.body?.code}`);
  const list = await call(admin, 'GET', `/platform/phone-verification/deferred?businessId=${st.companyId}`);
  check('switch off: existing deferred accounts stay listed, unverified, undeleted', list.body?.accounts?.some((x) => x.userId === st.kept) && sql(`SELECT CONCAT(phone_verification,'|',deleted_at IS NULL) FROM users WHERE id = UNHEX('${hex(st.kept)}')`) === 'deferred_by_platform|1');
  const required = await call(admin, 'POST', `/platform/businesses/${st.companyId}/test-staff`, { name: 'Still Required', phone: '+22238888887', role: 'store_employee', branchIds: [st.main], verification: 'required', confirmPassword: confirmPassword() });
  check('switch off: Required provisioning still works', required.status === 201, `${required.status} ${required.body?.code ?? ''}`);
}

console.log(`\nD224 journeys (${PHASE}): ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
