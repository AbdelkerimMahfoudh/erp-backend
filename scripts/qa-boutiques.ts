// ===========================================================================
// The QA fixture: ten boutiques with 100 items each, and a platform
// administrator — in a DISPOSABLE QA database, through the product itself.
//
//   npm run qa:seed                   # checks and reports; writes nothing
//   npm run qa:seed -- --apply        # provisions; a rerun adds nothing
//   npm run qa:seed -- --verify       # proves the dataset, through the API and in the database
//
//   QA_PASSWORD      the one password of all eleven accounts — required, never printed
//   QA_DATABASE_URL  mysql://user:password@host:port/prisma_qa — the QA database, outright;
//                    or, without it, backend/.env's DATABASE_URL server and credentials
//                    with the database QA_DB (default prisma_qa)
//
// Creating, migrating and seeding a QA database, step by step: README.md, "A QA dataset".
//
// Every boutique is its own company with one branch and one Owner
// (`boutique1@test.com` … `boutique10@test.com`), registered, verified and
// activated through the platform's own routes; its two categories and 32
// products are created through the catalogue, its day is opened, and its stock
// arrives by an ordinary receipt — 80 phones (IMEI units over 26 variants,
// some with a second IMEI) and 20 accessories (quantity stock, EAN-13
// barcodes). The data itself is `scripts/qa-fixture.ts`.
//
// **The product does the writing.** The command starts the real API
// (`src/main.ts`) as a private child process — loopback only, a random port,
// its own token secret, messaging disabled — connected to the QA database and
// nothing else, and stops it at the end. It READS state from the database and
// WRITES through that API, so every row is made by the code that owns it. Two
// exceptions, both the documented CLI paths: the platform administrator, which
// by design has no HTTP route (`prisma/create-platform-admin.ts`), and resetting
// a fixture Owner's password back to QA_PASSWORD — both with the app's own
// Argon2id hashing, both revoking the account's sessions.
//
// **Repeatable.** Registration, the day's opening and the receipt carry
// deterministic request keys, categories and products are matched before they
// are created, and every step already done is skipped: a second run adds
// nothing. A run that stopped halfway is finished by the next one.
//
// **Never anything but a QA database.** The database must be named
// `prisma_qa[_…]`; NODE_ENV and APP_ENV must not name a deployment; the
// connection must report that database; its migrations must be applied; and a
// FIRST run needs it empty — it refuses a database holding businesses or
// administrators this fixture did not create (a copy of live, say).
//
// **Credentials.** The password arrives in QA_PASSWORD — for this dataset,
// the QA-only value the user chose — and is hashed by the app; it is never
// printed, logged, stored here or passed to the API process. Nothing is sent to
// any address: in development a contact code stays in the API's in-memory
// outbox, and this command reads it back from its hash.
// ===========================================================================

import { config as loadEnv } from 'dotenv';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, openSync, readdirSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient, type SubscriptionStatus } from '@prisma/client';
import { HashingService } from '../src/common/security/hashing.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../src/common/utils/uuid.util';
import { ROLE_PERMISSIONS } from '../src/rbac/role-permissions';
import {
  ACCESSORIES,
  ACCESSORIES_CATEGORY,
  ADMIN_EMAIL,
  ADMIN_NAME,
  BOUTIQUES,
  CITY,
  GRANT_DAYS,
  GRANT_REASON,
  ITEMS_PER_BOUTIQUE,
  PHONES_CATEGORY,
  assertQaEnvironment,
  barcodeFor,
  boutiqueEmail,
  boutiqueName,
  openingKey,
  ownerName,
  phoneVariant,
  planFixture,
  privateApiEnvironment,
  qaPassword,
  receiptKey,
  receiptReference,
  registrationKey,
  resolveQaTarget,
  type BoutiquePlan,
  type QaTarget,
} from './qa-fixture';

// backend/.env, for DATABASE_URL when QA_DATABASE_URL is not given. It never overrides the shell.
loadEnv();

const APPLY = process.argv.includes('--apply');
const VERIFY = process.argv.includes('--verify');
const ROOT = join(__dirname, '..');

// ── Preconditions ──────────────────────────────────────────────────────────

/**
 * Everything that must hold before a single row is written, reported together.
 *
 * `ONLY_FULL_GROUP_BY`: the day's opening and Money queries fail under it (the
 * handoff's open item "fix ONLY_FULL_GROUP_BY in closing.service.ts"), so a QA
 * server running it could neither be seeded nor used. Live runs with
 * `sql_mode=''`. Drop this check once those queries are fixed.
 */
async function preflight(prisma: PrismaClient, target: QaTarget): Promise<string> {
  const [session] = await prisma.$queryRaw<{ db: string; mode: string }[]>`SELECT DATABASE() AS db, @@SESSION.sql_mode AS mode`;
  if (session.db !== target.database) throw new Error(`Refusing: the connection reports "${session.db}", not "${target.database}".`);

  const problems: string[] = [];
  if (/ONLY_FULL_GROUP_BY/i.test(session.mode)) {
    problems.push(
      "the server's sql_mode includes ONLY_FULL_GROUP_BY, under which the day's opening fails. Run the QA server as live runs: " +
        "sql_mode='' (start mysqld with --sql-mode=\"\", or SET GLOBAL sql_mode = '' as an administrator).",
    );
  }

  const local = readdirSync(join(ROOT, 'prisma', 'migrations'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  let applied = new Set<string>();
  try {
    const rows = await prisma.$queryRaw<{ name: string }[]>`
      SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    applied = new Set(rows.map((r) => r.name));
  } catch {
    // No migration table: nothing was ever applied.
  }
  const missing = local.filter((m) => !applied.has(m));
  if (missing.length > 0) {
    problems.push(`${missing.length} of ${local.length} migrations are not applied (first: ${missing[0]}). Run "npx prisma migrate deploy" against the QA database first.`);
    throw new Error(`Refusing:\n    - ${problems.join('\n    - ')}`);
  }

  // A first run needs an empty database; later runs recognise the fixture's own registrations.
  const keys = Array.from({ length: BOUTIQUES }, (_, i) => registrationKey(i + 1));
  const ours = await prisma.registrationAttempt.count({ where: { idempotencyKey: { in: keys } } });
  let contents = `the fixture's own data (${ours} of ${BOUTIQUES} boutiques registered)`;
  if (ours === 0) {
    const companies = await prisma.company.count();
    const admins = await prisma.platformAdmin.count({ where: { email: { not: ADMIN_EMAIL } } });
    if (companies > 0 || admins > 0) {
      problems.push(
        `the database holds ${companies} business(es) and ${admins} administrator(s) this fixture did not create. ` +
          'A first run needs a freshly migrated, empty QA database.',
      );
    }
    contents = 'an empty database';
  }
  if (problems.length > 0) throw new Error(`Refusing:\n    - ${problems.join('\n    - ')}`);
  return `sql_mode ok · ${local.length} of ${local.length} migrations applied · ${contents}`;
}

// ── State, read from the database ──────────────────────────────────────────

interface BoutiqueState {
  companyId: Buffer | null;
  ownerId: Buffer | null;
  verified: boolean;
  subscription: SubscriptionStatus | null;
  passwordOk: boolean;
  stocked: boolean;
}

async function readState(prisma: PrismaClient, hashing: HashingService, pw: string, n: number): Promise<BoutiqueState> {
  const attempt = await prisma.registrationAttempt.findUnique({
    where: { idempotencyKey: registrationKey(n) },
    select: { companyId: true },
  });
  const companyId = attempt?.companyId ?? null;
  if (!companyId) return { companyId: null, ownerId: null, verified: false, subscription: null, passwordOk: false, stocked: false };

  const owner = await prisma.user.findFirst({
    where: { companyId, email: boutiqueEmail(n) },
    select: { id: true, emailVerifiedAt: true, passwordHash: true },
  });
  const subscription = await prisma.subscription.findFirst({ where: { companyId }, select: { status: true } });
  const receipts = await prisma.purchase.count({ where: { companyId, clientUuid: uuidToBin(receiptKey(n)) } });
  return {
    companyId,
    ownerId: owner?.id ?? null,
    verified: Boolean(owner?.emailVerifiedAt),
    subscription: subscription?.status ?? null,
    passwordOk: owner ? await hashing.verify(owner.passwordHash, pw) : false,
    stocked: receipts > 0,
  };
}

/** What `--apply` would do for this boutique, step for step as `provisionBoutique` does it. */
function describeState(s: BoutiqueState): string {
  if (!s.companyId) return 'would be registered, verified, activated and stocked';
  const todo: string[] = [];
  if (!s.verified) todo.push('verified');
  if (s.subscription === 'pending_activation') todo.push('activated');
  else if (s.subscription !== 'activated') {
    return `present — ${todo.length > 0 ? `would be ${todo.join(', ')}; ` : ''}subscription ${s.subscription}, left as it is, nothing else done`;
  }
  if (!s.passwordOk) todo.push('password reset to QA_PASSWORD');
  if (!s.stocked) todo.push('stocked');
  return todo.length > 0 ? `present — would be ${todo.join(', ')}` : 'present · verified · activated · stocked';
}

// ── The private API ────────────────────────────────────────────────────────

interface PrivateApi {
  log: string;
  stop(): Promise<void>;
}

let apiBase = '';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function startPrivateApi(target: QaTarget): Promise<PrivateApi> {
  const port = await freePort();
  const log = join(tmpdir(), `qa-boutiques-api-${Date.now()}.log`);
  const out = openSync(log, 'a');
  const env = privateApiEnvironment(process.env, target, port, randomBytes(48).toString('base64url'), join(tmpdir(), 'qa-boutiques-uploads'));
  const child = spawn(process.execPath, ['-r', require.resolve('ts-node/register/transpile-only'), join('src', 'main.ts')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  closeSync(out);

  let running = true;
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => {
      running = false;
      resolve();
    }),
  );
  const killNow = (): void => {
    if (running) child.kill();
  };
  const onSignal = (): void => {
    killNow();
    process.exit(130);
  };
  process.once('exit', killNow);
  process.once('SIGINT', onSignal);

  const stop = async (): Promise<void> => {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('exit', killNow);
    if (!running) return;
    const force = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.kill('SIGTERM');
    await exited;
    clearTimeout(force);
  };

  const deadline = Date.now() + 180_000;
  for (;;) {
    if (!running) throw new Error(`the private API stopped while starting — see ${log}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`the private API did not start within three minutes — see ${log}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  apiBase = `http://127.0.0.1:${port}/api/v1`;
  return { log, stop };
}

// ── HTTP ───────────────────────────────────────────────────────────────────

interface Reply {
  status: number;
  json: any;
  cookie: string | null;
}

async function call(method: string, path: string, opts: { body?: unknown; token?: string; branch?: string; cookie?: string } = {}): Promise<Reply> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = await fetch(`${apiBase}/${path}`, {
      method,
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.branch ? { 'X-Branch-Id': opts.branch } : {}),
        ...(opts.cookie ? { Cookie: opts.cookie } : {}),
        'User-Agent': 'qa-boutiques',
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    // The public routes keep their own limits (ten a minute each), so a burst waits its turn.
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || 15;
      await new Promise((r) => setTimeout(r, Math.min(60, wait) * 1000));
      continue;
    }
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    const setCookie = res.headers.get('set-cookie');
    return { status: res.status, json, cookie: setCookie ? setCookie.split(';')[0] : null };
  }
  throw new Error(`${method} ${path}: still throttled`);
}

function expectOk(r: Reply, what: string): any {
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json?.code ?? r.json?.message ?? '')}`);
  return r.json;
}

const rowsOf = (j: any): any[] => (Array.isArray(j) ? j : j?.rows ?? j?.items ?? []);

// ── Steps ──────────────────────────────────────────────────────────────────

/** The administrator has no HTTP route by design; written the way `create-platform-admin.ts` writes one. */
async function ensureAdmin(prisma: PrismaClient, hashing: HashingService, pw: string, write: boolean): Promise<string> {
  const existing = await prisma.platformAdmin.findUnique({ where: { email: ADMIN_EMAIL } });
  if (existing && existing.isActive && !existing.deletedAt && (await hashing.verify(existing.passwordHash, pw))) return 'present';
  if (!write) return existing ? 'would be reset to QA_PASSWORD' : 'would be created';
  const passwordHash = await hashing.hash(pw);
  if (existing) {
    await prisma.platformAdmin.update({ where: { email: ADMIN_EMAIL }, data: { passwordHash, name: ADMIN_NAME, isActive: true, deletedAt: null } });
    await prisma.platformAdminSession.updateMany({ where: { adminId: existing.id, revokedAt: null }, data: { revokedAt: new Date() } });
    return 'reset to QA_PASSWORD';
  }
  await prisma.platformAdmin.create({ data: { id: newUuidV7Bin(), email: ADMIN_EMAIL, name: ADMIN_NAME, passwordHash } });
  return 'created';
}

/**
 * A fixture Owner whose password no longer matches — changed while testing — gets QA_PASSWORD back, the way
 * `prisma/create-user.ts` resets a test account, and loses every session the old password opened.
 */
async function resetOwnerPassword(prisma: PrismaClient, hashing: HashingService, ownerId: Buffer, pw: string): Promise<void> {
  await prisma.user.update({ where: { id: ownerId }, data: { passwordHash: await hashing.hash(pw) } });
  await prisma.authSession.updateMany({ where: { userId: ownerId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/** The code the outbox holds, read back from the hash the verification service stored — never delivered anywhere. */
async function codeFor(prisma: PrismaClient, destination: string): Promise<string> {
  const row = await prisma.contactVerification.findFirstOrThrow({
    where: { destination, consumedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { codeHash: true },
  });
  for (let i = 0; i < 1_000_000; i++) {
    const candidate = String(i).padStart(6, '0');
    if (createHash('sha256').update(`${destination}:${candidate}`).digest('hex') === row.codeHash) return candidate;
  }
  throw new Error(`could not recover the code for ${destination}`);
}

async function register(prisma: PrismaClient, n: number, pw: string): Promise<void> {
  const email = boutiqueEmail(n);
  const reg = expectOk(
    await call('POST', 'platform/register', {
      body: {
        idempotencyKey: registrationKey(n),
        ownerName: ownerName(n),
        businessName: boutiqueName(n),
        branchName: boutiqueName(n),
        city: CITY,
        email,
        password: pw,
        language: 'fr',
      },
    }),
    `register ${email}`,
  );
  if (!reg.continuation?.token) return;
  expectOk(await call('POST', 'platform/register/verify/start', { body: { continuation: reg.continuation.token, language: 'fr' } }), `verify start ${email}`);
  const code = await codeFor(prisma, email);
  const done = expectOk(await call('POST', 'platform/register/verify/confirm', { body: { continuation: reg.continuation.token, code } }), `verify ${email}`);
  // Completion signs the Owner in; the fixture is signed into later, so that session is closed at once.
  if (done?.accessToken) await call('POST', 'auth/logout-all', { token: done.accessToken, body: {} });
}

async function signIn(email: string, pw: string): Promise<{ token: string; branch: string }> {
  const login = expectOk(await call('POST', 'auth/login', { body: { identifier: email, password: pw } }), `sign in ${email}`);
  const branches = rowsOf(expectOk(await call('GET', 'auth/branches', { token: login.accessToken }), `branches ${email}`));
  if (branches.length !== 1) throw new Error(`${email}: expected one branch, got ${branches.length}`);
  return { token: login.accessToken, branch: branches[0].id };
}

async function stockBoutique(prisma: PrismaClient, plan: BoutiquePlan, companyId: Buffer, pw: string): Promise<string> {
  const { n } = plan;
  const as = await signIn(boutiqueEmail(n), pw);
  try {
    // A registered shop starts with no categories; its Owner creates them (Catalogue → Categories) — the two used here.
    const category = async (name: string, defaultTrackingType: 'imei' | 'quantity'): Promise<string> => {
      const found = await prisma.productCategory.findFirst({ where: { companyId, name }, select: { id: true } });
      if (found) return binToUuid(found.id);
      return expectOk(await call('POST', 'categories', { ...as, body: { name, defaultTrackingType } }), `category ${name}`).id;
    };
    const phonesCategory = await category(PHONES_CATEGORY, 'imei');
    const accessoriesCategory = await category(ACCESSORIES_CATEGORY, 'quantity');

    let created = 0;
    const product = async (brand: string, model: string, variant: string, details: Record<string, unknown>): Promise<string> => {
      const found = await prisma.product.findFirst({ where: { companyId, brand, model, variant, deletedAt: null }, select: { id: true } });
      if (found) return binToUuid(found.id);
      created++;
      return expectOk(await call('POST', 'products', { ...as, body: { brand, model, variant, ...details } }), `product ${brand} ${model} ${variant}`).id;
    };

    const items: unknown[] = [];
    for (const [index, line] of plan.shelf.entries()) {
      const productId = await product(line.brand, line.model, phoneVariant(line), {
        trackingType: 'imei',
        categoryId: phonesCategory,
        defaultCost: line.cost,
        defaultPrice: line.price,
      });
      items.push({ productId, unitCost: line.cost, units: plan.units[index] });
    }
    for (const [index, a] of ACCESSORIES.entries()) {
      const productId = await product(a.brand, a.model, a.variant, {
        trackingType: 'quantity',
        categoryId: accessoriesCategory,
        barcode: barcodeFor(n, index + 1),
        defaultCost: a.cost,
        defaultPrice: a.price,
      });
      items.push({ productId, unitCost: a.cost, quantity: a.quantity, price: a.price });
    }

    // Receipts wait for the day's opening (docs/63): open it — before 06:00 start today early — keeping the amounts.
    const day = expectOk(await call('GET', 'closings/business-day', as), 'business day');
    if (day.door === 'closed') {
      throw new Error(`${boutiqueName(n)}: today's business day is closed, so it cannot receive stock. Reopen it in the app, then run --apply again.`);
    }
    if (day.door === 'never_opened') {
      const view = expectOk(await call('GET', 'closings/open/view', as), 'open view');
      const mode = (view.openChoices ?? []).includes('start_new') ? 'start_new' : 'continue';
      expectOk(
        await call('POST', 'closings/open', { ...as, body: { mode, openingMoney: { clientUuid: openingKey(n), decision: 'keep' } } }),
        `open ${boutiqueName(n)}`,
      );
    }

    expectOk(
      await call('POST', 'purchases', {
        ...as,
        body: { clientUuid: receiptKey(n), paymentMethod: 'cash', referenceNo: receiptReference(n), items },
      }),
      `receipt ${boutiqueName(n)}`,
    );
    return `${created} product(s) created · ${plan.phones} phones + ${plan.accessories} accessories received`;
  } finally {
    await call('POST', 'auth/logout-all', { token: as.token, body: {} });
  }
}

async function provisionBoutique(
  prisma: PrismaClient,
  hashing: HashingService,
  plan: BoutiquePlan,
  pw: string,
  adminCookie: () => Promise<string>,
): Promise<string> {
  const { n } = plan;
  const done: string[] = [];
  let state = await readState(prisma, hashing, pw, n);

  if (!state.companyId || !state.verified) {
    await register(prisma, n, pw);
    done.push(state.companyId ? 'verified' : 'registered and verified');
    state = await readState(prisma, hashing, pw, n);
    if (!state.companyId || !state.ownerId || !state.verified) throw new Error(`${boutiqueName(n)}: registration did not complete`);
  }

  if (state.subscription === 'pending_activation') {
    expectOk(
      await call('POST', `platform/businesses/${binToUuid(state.companyId)}/activate-grant`, {
        cookie: await adminCookie(),
        body: { days: GRANT_DAYS, reason: GRANT_REASON, confirmPassword: pw },
      }),
      `activate ${boutiqueName(n)}`,
    );
    done.push(`activated (${GRANT_DAYS}-day grant)`);
  } else if (state.subscription !== 'activated') {
    // Suspended, cancelled or rejected from the platform portal: somebody's decision, which a fixture does not overrule.
    return `subscription ${state.subscription} — left as it is, nothing else done`;
  }

  if (!state.passwordOk && state.ownerId) {
    await resetOwnerPassword(prisma, hashing, state.ownerId, pw);
    done.push('password reset to QA_PASSWORD');
  }

  if (!state.stocked) done.push(await stockBoutique(prisma, plan, state.companyId, pw));
  return done.length > 0 ? done.join(' · ') : 'already complete — nothing to do';
}

/** The API serves THIS database: it has to accept the administrator this command wrote there. */
async function adminSignIn(pw: string): Promise<string> {
  const signIn = await call('POST', 'platform/admin/sign-in', { body: { email: ADMIN_EMAIL, password: pw } });
  const cookie = signIn.cookie ?? (signIn.json?.sessionToken ? `erp_platform_session=${signIn.json.sessionToken}` : null);
  if (signIn.status !== 200 || !cookie) throw new Error(`the administrator could not sign in to the private API (${signIn.status})`);
  return cookie;
}

// ── Verification ───────────────────────────────────────────────────────────

/**
 * The dataset exactly as seeded: eleven sign-ins with QA_PASSWORD; each Owner in its own single branch, holding
 * exactly the Owner role's permissions, with exactly its 100 items — the planned IMEIs and barcodes — and nobody
 * else's; every password stored as Argon2id; the administrator on the platform and nowhere in a shop. After QA has
 * sold or moved stock the counts differ by design — recreate the database for a fresh dataset.
 */
async function verify(prisma: PrismaClient, plan: BoutiquePlan[], pw: string): Promise<boolean> {
  let passed = 0;
  let failed = 0;
  const check = (name: string, ok: boolean, detail = ''): void => {
    if (ok) passed++;
    else failed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const ownerPermissions = [...ROLE_PERMISSIONS.owner].sort().join(',');

  const owners: { n: number; token: string; branch: string; productId: string; imei: string }[] = [];
  for (const p of plan) {
    const { n } = p;
    const email = boutiqueEmail(n);
    const login = await call('POST', 'auth/login', { body: { identifier: email, password: pw } });
    check(`${email} signs in`, login.status === 200 && Boolean(login.json?.accessToken), String(login.status));
    if (login.status !== 200) continue;
    const token = login.json.accessToken as string;

    const branches = rowsOf((await call('GET', 'auth/branches', { token })).json);
    check(`${email}: one branch, its own`, branches.length === 1 && branches[0].name === boutiqueName(n), branches.map((b: any) => b.name).join(', '));
    const branch = branches[0]?.id as string;

    const held = ((await call('GET', 'auth/permissions', { token, branch })).json?.permissions ?? []) as string[];
    check(`${email}: holds exactly the Owner role's ${ROLE_PERMISSIONS.owner.length} permissions`, [...held].sort().join(',') === ownerPermissions, `${held.length} held`);

    const summary = rowsOf((await call('GET', 'inventory/summary', { token, branch })).json);
    const available = summary.reduce((s: number, r: any) => s + Number(r.available ?? 0), 0);
    const phones = summary.filter((r: any) => r.trackingType === 'imei').reduce((s: number, r: any) => s + Number(r.available ?? 0), 0);
    check(
      `${email}: exactly ${ITEMS_PER_BOUTIQUE} available — ${phones} phones, ${available - phones} accessories, ${summary.length} variants`,
      available === ITEMS_PER_BOUTIQUE && phones === p.phones,
      `available ${available}`,
    );
    const list = (await call('GET', 'inventory?status=in_stock&limit=1', { token, branch })).json;
    check(`${email}: the unit list agrees (${list?.totals?.units} phones in stock)`, list?.totals?.units === p.phones, JSON.stringify(list?.totals ?? null));

    const firstPhone = summary.find((r: any) => r.trackingType === 'imei');
    const unitList = rowsOf((await call('GET', `inventory?productId=${firstPhone?.productId}&limit=1`, { token, branch })).json);
    owners.push({ n, token, branch, productId: firstPhone?.productId, imei: unitList[0]?.identifier ?? unitList[0]?.imeiPrimary });
  }

  // The receipt, in the database: the planned identifiers and nothing else, every password hashed with Argon2id.
  for (const p of plan) {
    const { n } = p;
    const attempt = await prisma.registrationAttempt.findUnique({ where: { idempotencyKey: registrationKey(n) }, select: { companyId: true } });
    const companyId = attempt?.companyId ?? Buffer.alloc(16);
    const receipt = await prisma.purchase.findFirst({ where: { companyId, clientUuid: uuidToBin(receiptKey(n)) }, select: { id: true } });
    const units = receipt
      ? await prisma.unit.findMany({ where: { companyId, purchaseId: receipt.id }, select: { imeiPrimary: true, imeiSecondary: true } })
      : [];
    const got = units.map((u) => `${u.imeiPrimary}/${u.imeiSecondary ?? ''}`).sort().join(',');
    const want = p.units.flat().map((u) => `${u.identifier}/${u.imeiSecondary ?? ''}`).sort().join(',');
    const seconds = p.units.flat().filter((u) => u.imeiSecondary).length;
    const barcodes = await prisma.product.count({
      where: { companyId, barcode: { in: ACCESSORIES.map((_, i) => barcodeFor(n, i + 1)) }, trackingType: 'quantity' },
    });
    check(
      `${boutiqueName(n)}: its receipt holds the planned ${p.phones} IMEIs (${seconds} with a second) and ${barcodes} barcoded accessories`,
      Boolean(receipt) && got === want && barcodes === ACCESSORIES.length,
      receipt ? `${units.length} units` : 'no receipt',
    );
    const owner = await prisma.user.findFirst({ where: { companyId, email: boutiqueEmail(n) }, select: { passwordHash: true } });
    check(`${boutiqueEmail(n)}: password stored as Argon2id`, Boolean(owner?.passwordHash.startsWith('$argon2id$')));
  }

  // Another boutique's records: never readable.
  for (const me of owners) {
    const other = owners.find((o) => o.n === (me.n % BOUTIQUES) + 1);
    if (!other) continue;
    // The control: the same reads of its OWN product and phone succeed, so a refusal below is the boundary, not a typo.
    const ownProduct = await call('GET', `products/${me.productId}`, { token: me.token, branch: me.branch });
    const ownUnit = await call('GET', `units/${me.imei}`, { token: me.token, branch: me.branch });
    check(`Boutique ${me.n} reads its own product and phone (${me.imei})`, ownProduct.status === 200 && ownUnit.status === 200 && /^\d{15}$/.test(me.imei ?? ''), `${ownProduct.status} / ${ownUnit.status}`);
    const product = await call('GET', `products/${other.productId}`, { token: me.token, branch: me.branch });
    const unit = await call('GET', `units/${other.imei}`, { token: me.token, branch: me.branch });
    const theirShelf = await call('GET', 'inventory/summary', { token: me.token, branch: other.branch });
    check(
      `Boutique ${me.n} cannot read Boutique ${other.n}: its product, its phone, its shelf`,
      product.status >= 400 && unit.status >= 400 && theirShelf.status >= 400,
      `${product.status} / ${unit.status} / ${theirShelf.status}`,
    );
    if (me.n === 1) {
      const platform = await call('GET', 'platform/businesses', { token: me.token });
      check('an Owner has no platform access', platform.status === 401 || platform.status === 403, String(platform.status));
    }
  }

  // The administrator: the platform, and nothing of a shop.
  const signIn = await call('POST', 'platform/admin/sign-in', { body: { email: ADMIN_EMAIL, password: pw } });
  const cookie = signIn.cookie ?? (signIn.json?.sessionToken ? `erp_platform_session=${signIn.json.sessionToken}` : '');
  check(`${ADMIN_EMAIL} signs in to the platform`, signIn.status === 200 && Boolean(cookie), String(signIn.status));
  const me = await call('GET', 'platform/admin/me', { cookie });
  const businesses = await call('GET', 'platform/businesses', { cookie });
  const qa = rowsOf(businesses.json).filter((b: any) => /^Boutique \d+$/.test(b.name));
  check('the administrator sees the ten boutiques on the platform', me.status === 200 && businesses.status === 200 && qa.length === BOUTIQUES, `${me.status} / ${businesses.status} / ${qa.length}`);
  const shop = await call('GET', 'products', { cookie });
  const shopLogin = await call('POST', 'auth/login', { body: { identifier: ADMIN_EMAIL, password: pw } });
  check('the administrator has no shop access: no shop session, no shop account', shop.status === 401 && shopLogin.status === 401, `${shop.status} / ${shopLogin.status}`);
  const admin = await prisma.platformAdmin.findUnique({ where: { email: ADMIN_EMAIL }, select: { passwordHash: true } });
  check(`${ADMIN_EMAIL}: password stored as Argon2id`, Boolean(admin?.passwordHash.startsWith('$argon2id$')));
  await call('POST', 'platform/admin/sign-out', { cookie, body: {} });

  // The sessions opened here are closed again.
  for (const o of owners) await call('POST', 'auth/logout-all', { token: o.token, body: {} });
  console.log(`\n  ${failed === 0 ? `all ${passed} checks passed` : `${failed} of ${passed + failed} checks FAILED`}\n`);
  return failed === 0;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (APPLY && VERIFY) throw new Error('Pass --apply or --verify, not both.');
  assertQaEnvironment(process.env);
  const target = resolveQaTarget(process.env);
  const pw = qaPassword(process.env);
  const plan = planFixture();

  console.log(`\n  QA fixture — database ${target.database} on ${target.server}${VERIFY ? '   (verification)' : APPLY ? '' : '   (dry run — nothing is written)'}\n`);
  const identifiers = plan.reduce((s, p) => s + p.units.flat().reduce((c, u) => c + (u.imeiSecondary ? 2 : 1), 0) + ACCESSORIES.length, 0);
  console.log(`  plan: ${BOUTIQUES} boutiques × (${plan[0].phones} phones + ${plan[0].accessories} accessories); ${identifiers} distinct identifiers (IMEIs and barcodes)`);

  const prisma = new PrismaClient({ datasources: { db: { url: target.url } } });
  const hashing = new HashingService();
  let api: PrivateApi | null = null;
  try {
    console.log(`  checks: ${await preflight(prisma, target)}`);

    if (!APPLY && !VERIFY) {
      const admin = await ensureAdmin(prisma, hashing, pw, false);
      console.log(`  administrator ${ADMIN_EMAIL}: ${admin}`);
      for (const p of plan) {
        const state = await readState(prisma, hashing, pw, p.n);
        console.log(`  ${boutiqueName(p.n).padEnd(12)} ${describeState(state)}`);
      }
      console.log('\n  nothing was written. Pass --apply to provision, --verify to check the dataset through the API.\n');
      return;
    }

    if (APPLY) {
      const admin = await ensureAdmin(prisma, hashing, pw, true);
      console.log(`  administrator ${ADMIN_EMAIL}: ${admin}`);
    }
    api = await startPrivateApi(target);
    console.log(`  private API up (loopback only; its log: ${api.log})\n`);

    if (VERIFY) {
      if (!(await verify(prisma, plan, pw))) process.exitCode = 1;
      return;
    }

    // Signed in only when an activation needs it, so a rerun with nothing to do writes nothing at all.
    let adminSession = null as string | null;
    const adminCookie = async (): Promise<string> => (adminSession ??= await adminSignIn(pw));
    for (const p of plan) {
      const outcome = await provisionBoutique(prisma, hashing, p, pw, adminCookie);
      console.log(`  ${boutiqueName(p.n).padEnd(12)} ${outcome}`);
    }
    if (adminSession) await call('POST', 'platform/admin/sign-out', { cookie: adminSession, body: {} });
    console.log(
      `\n  done. Sign in with QA_PASSWORD as ${boutiqueEmail(1)} … ${boutiqueEmail(BOUTIQUES)} (the app) or ${ADMIN_EMAIL} (the platform portal).` +
        '\n  Check it: npm run qa:seed -- --verify\n',
    );
  } finally {
    await api?.stop();
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`\n  failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
