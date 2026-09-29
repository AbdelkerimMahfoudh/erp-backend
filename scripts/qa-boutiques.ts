// ===========================================================================
// The QA fixture: ten boutiques, 100 available units each, and a platform
// administrator — in the DISPOSABLE QA database, through the product itself.
//
//   QA_PASSWORD=… npx ts-node scripts/qa-boutiques.ts            # reports only
//   QA_PASSWORD=… npx ts-node scripts/qa-boutiques.ts --apply    # provisions
//   QA_PASSWORD=… npx ts-node scripts/qa-boutiques.ts --verify   # checks it through the API only
//
//   QA_DB   the QA schema (default `prisma_qa`; anything else starting `prisma_qa`)
//   QA_API  the QA API serving that schema (default http://127.0.0.1:3020/api/v1)
//
// Every boutique is its own company with one branch and one Owner
// (`boutique1@test.com` … `boutique10@test.com`), registered, verified and
// activated through the platform's own routes; its two categories and 32 products
// are created through the catalogue, its day is opened, and its stock arrives by an
// ordinary receipt — 80 phones (IMEI units over 26 variants, some with a second
// IMEI) and 20 accessories (quantity stock, EAN-13 barcodes). Nothing is written into a table a service
// owns, except the platform administrator, which by design has no HTTP route
// (`prisma/create-platform-admin.ts`): it is created the same way, with the app's
// own hashing.
//
// **Repeatable.** Registration and the receipt carry deterministic request keys,
// products are matched before they are created, and verification and activation
// are skipped when done: a second run changes nothing.
//
// **Never the live database.** The schema must be a `prisma_qa*` schema, and the
// API must prove it serves that schema — it has to accept the administrator this
// script just wrote there — before anything is sent to it.
//
// **Credentials.** The one password arrives in `QA_PASSWORD`, is hashed by the
// app, and is never printed, logged or stored here. Nothing is ever sent to any
// address: the platform has no email provider, and in development a contact code
// stays in the API's in-memory outbox; this script reads it back from its hash.
//
// Note: the administrator's QA password may be shorter than the 12 characters
// `create-platform-admin.ts` asks of a real one — this account exists only in
// the QA schema.
// ===========================================================================

import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { createHash as sha256 } from 'node:crypto';
import { HashingService } from '../src/common/security/hashing.service';
import { isValidImei, luhnValid } from '../src/inventory/imei.util';
import { newUuidV7Bin } from '../src/common/utils/uuid.util';

loadEnv();

const APPLY = process.argv.includes('--apply');
const VERIFY = process.argv.includes('--verify');
const QA_DB = process.env.QA_DB ?? 'prisma_qa';
const QA_API = (process.env.QA_API ?? 'http://127.0.0.1:3020/api/v1').replace(/\/+$/, '');
const BOUTIQUES = 10;
const ADMIN_EMAIL = 'admin@test.com';
const ADMIN_NAME = 'QA Platform Administrator';
const GRANT_DAYS = 365;
const GRANT_REASON = 'QA fixture — ten test boutiques (scripts/qa-boutiques.ts)';

// ── Guards ─────────────────────────────────────────────────────────────────

function qaDatabaseUrl(): string {
  if (!/^prisma_qa[a-z0-9_]*$/.test(QA_DB)) throw new Error(`Refusing: "${QA_DB}" is not a prisma_qa* schema.`);
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is not set (backend/.env). Refusing.');
  const url = new URL(base);
  url.pathname = `/${QA_DB}`;
  const name = url.pathname.slice(1);
  for (const forbidden of [/^phonestore$/i, /stag/i, /prod/i, /live/i, /demo/i]) {
    if (forbidden.test(name)) throw new Error(`Refusing: "${name}" looks protected.`);
  }
  return url.toString();
}

function password(): string {
  const value = process.env.QA_PASSWORD;
  if (!value) throw new Error('Set QA_PASSWORD in the environment. It is never a command-line argument.');
  if (value.length < 8) throw new Error('QA_PASSWORD must have at least 8 characters.');
  return value;
}

// ── Deterministic identities ───────────────────────────────────────────────

/** A request key derived from a name, so a rerun sends the same key and is answered with what was done. */
function keyFor(name: string): string {
  const h = sha256('sha256').update(`qa-boutiques:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function checkDigit14(fourteen: string): string {
  for (let d = 0; d <= 9; d++) if (luhnValid(fourteen + d)) return fourteen + d;
  throw new Error(`no check digit completes ${fourteen}`);
}

/**
 * Synthetic IMEIs — no real device identifier is copied. The TAC is `0199`, the boutique and the model (a range no
 * allocation uses here), the serial runs per unit, and the fifteenth digit is the Luhn check the app validates.
 * A second IMEI sits in a disjoint serial band, so it never equals any first IMEI.
 */
function imeiFor(boutique: number, model: number, unit: number, secondary = false): string {
  const tac = `0199${String(boutique).padStart(2, '0')}${String(model).padStart(2, '0')}`;
  const serial = String((secondary ? 500_000 : 100_000) + unit).padStart(6, '0');
  const imei = checkDigit14(tac + serial);
  if (!isValidImei(imei)) throw new Error(`generated an invalid IMEI ${imei}`);
  return imei;
}

/** EAN-13 in the in-store range (`29…`): thirteen digits, so never an IMEI, and distinct per boutique and product. */
function barcodeFor(boutique: number, item: number): string {
  const twelve = `29${String(boutique).padStart(3, '0')}${String(item).padStart(7, '0')}`;
  const sum = [...twelve].reduce((s, c, i) => s + Number(c) * (i % 2 === 0 ? 1 : 3), 0);
  return twelve + ((10 - (sum % 10)) % 10);
}

// ── The shelf ──────────────────────────────────────────────────────────────

interface PhoneLine {
  brand: string;
  model: string;
  storage: string;
  colour: string;
  cost: number;
  price: number;
  /** How many of this exact variant the boutique holds. */
  units: number;
  /** A second IMEI on every unit of this variant (dual-SIM handsets; still one unit each). */
  dual?: boolean;
}

/** Thirty variants; each boutique takes 26 of them (a different window), 80 units in all. MRU, as the shops price. */
const PHONES: Omit<PhoneLine, 'units'>[] = [
  { brand: 'Apple', model: 'iPhone 15 Pro Max', storage: '256 GB', colour: 'Gray', cost: 44000, price: 49500, dual: true },
  { brand: 'Apple', model: 'iPhone 15 Pro', storage: '128 GB', colour: 'Blue', cost: 38000, price: 42500, dual: true },
  { brand: 'Apple', model: 'iPhone 15', storage: '128 GB', colour: 'Black', cost: 29000, price: 33000 },
  { brand: 'Apple', model: 'iPhone 14', storage: '128 GB', colour: 'Purple', cost: 24000, price: 27500 },
  { brand: 'Apple', model: 'iPhone 13', storage: '128 GB', colour: 'Pink', cost: 19000, price: 22000 },
  { brand: 'Apple', model: 'iPhone 13', storage: '256 GB', colour: 'Blue', cost: 21500, price: 24500 },
  { brand: 'Apple', model: 'iPhone 12', storage: '64 GB', colour: 'White', cost: 13500, price: 16000 },
  { brand: 'Apple', model: 'iPhone 11', storage: '64 GB', colour: 'Black', cost: 10000, price: 12500 },
  { brand: 'Samsung', model: 'Galaxy S24 Ultra', storage: '256 GB', colour: 'Gray', cost: 41000, price: 46000, dual: true },
  { brand: 'Samsung', model: 'Galaxy S24', storage: '128 GB', colour: 'Yellow', cost: 27000, price: 30500, dual: true },
  { brand: 'Samsung', model: 'Galaxy S23 FE', storage: '128 GB', colour: 'Green', cost: 19500, price: 22500 },
  { brand: 'Samsung', model: 'Galaxy A55', storage: '128 GB', colour: 'Blue', cost: 14500, price: 17000, dual: true },
  { brand: 'Samsung', model: 'Galaxy A35', storage: '128 GB', colour: 'Black', cost: 11500, price: 13500, dual: true },
  { brand: 'Samsung', model: 'Galaxy A15', storage: '128 GB', colour: 'Blue', cost: 6500, price: 8000, dual: true },
  { brand: 'Samsung', model: 'Galaxy A05s', storage: '64 GB', colour: 'Silver', cost: 4500, price: 5500, dual: true },
  { brand: 'Redmi', model: 'Redmi Note 13 Pro', storage: '256 GB', colour: 'Purple', cost: 12500, price: 14500, dual: true },
  { brand: 'Redmi', model: 'Redmi Note 13', storage: '128 GB', colour: 'Black', cost: 8500, price: 10000, dual: true },
  { brand: 'Redmi', model: 'Redmi 13C', storage: '128 GB', colour: 'Green', cost: 5000, price: 6200, dual: true },
  { brand: 'Xiaomi', model: 'Xiaomi 14', storage: '256 GB', colour: 'White', cost: 30000, price: 34000, dual: true },
  { brand: 'POCO', model: 'POCO X6 Pro', storage: '256 GB', colour: 'Yellow', cost: 13500, price: 15500, dual: true },
  { brand: 'Tecno', model: 'Camon 30', storage: '256 GB', colour: 'Black', cost: 9500, price: 11000, dual: true },
  { brand: 'Tecno', model: 'Spark 20 Pro', storage: '256 GB', colour: 'Orange', cost: 7000, price: 8300, dual: true },
  { brand: 'Infinix', model: 'Note 40 Pro', storage: '256 GB', colour: 'Green', cost: 10500, price: 12300, dual: true },
  { brand: 'Infinix', model: 'Hot 40', storage: '128 GB', colour: 'Blue', cost: 5500, price: 6700, dual: true },
  { brand: 'itel', model: 'A70', storage: '64 GB', colour: 'Gold', cost: 3000, price: 3800, dual: true },
  { brand: 'OPPO', model: 'Reno12', storage: '256 GB', colour: 'Silver', cost: 16500, price: 19000, dual: true },
  { brand: 'OPPO', model: 'A58', storage: '128 GB', colour: 'Green', cost: 7500, price: 8900, dual: true },
  { brand: 'realme', model: 'C65', storage: '128 GB', colour: 'Purple', cost: 5200, price: 6400, dual: true },
  { brand: 'Huawei', model: 'nova 12', storage: '256 GB', colour: 'Black', cost: 15000, price: 17500, dual: true },
  { brand: 'Honor', model: 'X8b', storage: '128 GB', colour: 'Silver', cost: 8000, price: 9500, dual: true },
];

/** How 80 units spread over 26 variants: a few deep lines for the variant and list tests, most with two or three. */
const DEPTHS = [6, 6, 5, 5, 4, 4, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1];

interface AccessoryLine {
  brand: string;
  model: string;
  variant: string;
  cost: number;
  price: number;
  quantity: number;
}

/** Twenty pieces over six products. */
const ACCESSORIES: AccessoryLine[] = [
  { brand: 'Anker', model: 'PowerCore 10000', variant: 'Black', cost: 700, price: 950, quantity: 4 },
  { brand: 'Apple', model: 'USB-C Power Adapter', variant: '20W', cost: 550, price: 800, quantity: 3 },
  { brand: 'Samsung', model: 'Super Fast Charger', variant: '25W', cost: 450, price: 650, quantity: 3 },
  { brand: 'Anker', model: 'USB-C to Lightning Cable', variant: '1m', cost: 200, price: 350, quantity: 4 },
  { brand: 'Generic', model: 'Tempered Glass', variant: 'iPhone 13/14', cost: 60, price: 150, quantity: 3 },
  { brand: 'Generic', model: 'Silicone Case', variant: 'iPhone 15 · Black', cost: 90, price: 250, quantity: 3 },
];

function shelfFor(boutique: number): PhoneLine[] {
  // A different window over the thirty variants for each boutique, and a different order of depths.
  const start = ((boutique - 1) * 3) % PHONES.length;
  const picked = Array.from({ length: DEPTHS.length }, (_, i) => PHONES[(start + i) % PHONES.length]);
  const rotate = (boutique - 1) % DEPTHS.length;
  return picked.map((p, i) => ({ ...p, units: DEPTHS[(i + rotate) % DEPTHS.length] }));
}

// ── HTTP ───────────────────────────────────────────────────────────────────

interface Reply {
  status: number;
  json: any;
  cookie: string | null;
}

async function call(method: string, path: string, opts: { body?: unknown; token?: string; branch?: string; cookie?: string } = {}): Promise<Reply> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = await fetch(`${QA_API}/${path}`, {
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
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || 15;
      await new Promise((r) => setTimeout(r, Math.min(60, wait) * 1000));
      continue;
    }
    let json: any = null;
    try { json = await res.json(); } catch { json = null; }
    const setCookie = res.headers.get('set-cookie');
    return { status: res.status, json, cookie: setCookie ? setCookie.split(';')[0] : null };
  }
  throw new Error(`${method} ${path}: still throttled`);
}

function expectOk(r: Reply, what: string): any {
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json?.code ?? r.json?.message ?? '')}`);
  return r.json;
}

// ── Steps ──────────────────────────────────────────────────────────────────

async function ensureAdmin(prisma: PrismaClient, hashing: HashingService, pw: string): Promise<string> {
  const existing = await prisma.platformAdmin.findUnique({ where: { email: ADMIN_EMAIL } });
  if (existing && existing.isActive && !existing.deletedAt && (await hashing.verify(existing.passwordHash, pw))) return 'present';
  if (!APPLY) return existing ? 'would be reset' : 'would be created';
  const passwordHash = await hashing.hash(pw);
  if (existing) {
    await prisma.platformAdmin.update({ where: { email: ADMIN_EMAIL }, data: { passwordHash, name: ADMIN_NAME, isActive: true, deletedAt: null } });
    await prisma.platformAdminSession.updateMany({ where: { adminId: existing.id, revokedAt: null }, data: { revokedAt: new Date() } });
    return 'reset';
  }
  await prisma.platformAdmin.create({ data: { id: newUuidV7Bin(), email: ADMIN_EMAIL, name: ADMIN_NAME, passwordHash } });
  return 'created';
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
    if (sha256('sha256').update(`${destination}:${candidate}`).digest('hex') === row.codeHash) return candidate;
  }
  throw new Error(`could not recover the code for ${destination}`);
}

async function provisionBoutique(n: number, prisma: PrismaClient, pw: string, adminCookie: string): Promise<{ companyId: string; created: boolean }> {
  const email = `boutique${n}@test.com`;
  const reg = expectOk(
    await call('POST', 'platform/register', {
      body: {
        idempotencyKey: `qa-boutique-${n}`,
        ownerName: `Owner Boutique ${n}`,
        businessName: `Boutique ${n}`,
        branchName: `Boutique ${n}`,
        city: 'Nouakchott',
        email,
        password: pw,
        language: 'fr',
      },
    }),
    `register ${email}`,
  );
  if (reg.continuation?.token) {
    expectOk(await call('POST', 'platform/register/verify/start', { body: { continuation: reg.continuation.token, language: 'fr' } }), `verify start ${email}`);
    const code = await codeFor(prisma, email);
    const done = expectOk(await call('POST', 'platform/register/verify/confirm', { body: { continuation: reg.continuation.token, code } }), `verify ${email}`);
    // Completion signs the Owner in; the fixture is signed into later, so that session is closed at once.
    if (done?.accessToken) await call('POST', 'auth/logout-all', { token: done.accessToken, body: {} });
  }
  const found = expectOk(await call('GET', `platform/businesses?q=${encodeURIComponent(email)}`, { cookie: adminCookie }), `find ${email}`);
  const row = (found.rows ?? []).find((r: any) => r.name === `Boutique ${n}`);
  if (!row) throw new Error(`Boutique ${n} is not listed after registration`);
  const status = row.subscription?.status ?? row.status ?? row.subscriptionStatus;
  if (status !== 'activated') {
    expectOk(
      await call('POST', `platform/businesses/${row.id}/activate-grant`, { cookie: adminCookie, body: { days: GRANT_DAYS, reason: GRANT_REASON, confirmPassword: pw } }),
      `activate Boutique ${n}`,
    );
  }
  return { companyId: row.id, created: Boolean(reg.created) };
}

async function signIn(email: string, pw: string): Promise<{ token: string; branch: string }> {
  const login = expectOk(await call('POST', 'auth/login', { body: { identifier: email, password: pw } }), `sign in ${email}`);
  const branches = expectOk(await call('GET', 'auth/branches', { token: login.accessToken }), `branches ${email}`);
  if (!Array.isArray(branches) || branches.length !== 1) throw new Error(`${email}: expected one branch, got ${Array.isArray(branches) ? branches.length : '?'}`);
  return { token: login.accessToken, branch: branches[0].id };
}

async function stockBoutique(n: number, pw: string): Promise<{ products: number; phones: number; accessories: number; stocked: boolean }> {
  const email = `boutique${n}@test.com`;
  const { token, branch } = await signIn(email, pw);
  const as = { token, branch };

  // A registered shop starts with no categories; its Owner creates them (Catalogue → Categories) — the two used here.
  const categories = expectOk(await call('GET', 'categories', as), 'categories');
  const list: any[] = Array.isArray(categories) ? categories : categories.rows ?? categories.items ?? [];
  const category = async (name: string, defaultTrackingType: 'imei' | 'quantity') =>
    list.find((c) => c.name === name) ?? expectOk(await call('POST', 'categories', { ...as, body: { name, defaultTrackingType } }), `category ${name}`);
  const phonesCat = await category('Smartphones', 'imei');
  const accessoriesCat = await category('Accessories', 'quantity');

  const existing = expectOk(await call('GET', 'products?limit=100&active=all', as), 'products');
  const products: any[] = Array.isArray(existing) ? existing : existing.rows ?? existing.items ?? [];
  const idOf = async (brand: string, model: string, variant: string, create: Record<string, unknown>): Promise<string> => {
    const hit = products.find((p) => p.brand === brand && p.model === model && (p.variant ?? '') === variant);
    if (hit) return hit.id;
    const made = expectOk(await call('POST', 'products', { ...as, body: { brand, model, variant, ...create } }), `product ${brand} ${model} ${variant}`);
    products.push(made);
    return made.id;
  };

  const shelf = shelfFor(n);
  const items: unknown[] = [];
  for (const [index, line] of shelf.entries()) {
    const variant = `${line.storage} · ${line.colour}`;
    const productId = await idOf(line.brand, line.model, variant, {
      trackingType: 'imei',
      categoryId: phonesCat.id,
      defaultCost: line.cost,
      defaultPrice: line.price,
    });
    const model = PHONES.indexOf(PHONES.find((p) => p.brand === line.brand && p.model === line.model && p.storage === line.storage)!);
    items.push({
      productId,
      unitCost: line.cost,
      units: Array.from({ length: line.units }, (_, u) => ({
        identifier: imeiFor(n, model, index * 10 + u),
        ...(line.dual && u % 2 === 0 ? { imeiSecondary: imeiFor(n, model, index * 10 + u, true) } : {}),
      })),
    });
  }
  for (const [index, a] of ACCESSORIES.entries()) {
    const productId = await idOf(a.brand, a.model, a.variant, {
      trackingType: 'quantity',
      categoryId: accessoriesCat.id,
      barcode: barcodeFor(n, index + 1),
      defaultCost: a.cost,
      defaultPrice: a.price,
    });
    items.push({ productId, unitCost: a.cost, quantity: a.quantity, price: a.price });
  }

  const phones = shelf.reduce((s, l) => s + l.units, 0);
  const accessories = ACCESSORIES.reduce((s, a) => s + a.quantity, 0);
  // Already received (the fixture's first IMEI is on the shelf or was sold from it): no day is opened, nothing sent.
  const firstImei = (items[0] as { units: { identifier: string }[] }).units[0].identifier;
  if ((await call('GET', `units/${firstImei}`, as)).status === 200) return { products: products.length, phones, accessories, stocked: true };

  // Receipts wait for the day's opening (docs/63): open it — before 06:00 start today early — keeping the amounts.
  const day = expectOk(await call('GET', 'closings/business-day', as), 'business day');
  if (day.door === 'never_opened') {
    const view = expectOk(await call('GET', 'closings/open/view', as), 'open view');
    const mode = (view.openChoices ?? []).includes('start_new') ? 'start_new' : 'continue';
    expectOk(
      await call('POST', 'closings/open', { ...as, body: { mode, openingMoney: { clientUuid: keyFor(`boutique-${n}-opening`), decision: 'keep' } } }),
      `open Boutique ${n}`,
    );
  }

  const receipt = await call('POST', 'purchases', {
    ...as,
    body: { clientUuid: keyFor(`boutique-${n}-stock-v1`), paymentMethod: 'cash', referenceNo: `QA-B${n}-STOCK`, items },
  });
  expectOk(receipt, `receipt Boutique ${n}`);
  return { products: products.length, phones, accessories, stocked: false };
}

// ── Verification, through the API only ─────────────────────────────────────

/**
 * The eleven sign-ins; each Owner sees exactly their own 100 available units and none of another boutique's; the
 * Owners have no platform access; the administrator reaches the platform and nothing of a shop.
 */
async function verify(pw: string): Promise<boolean> {
  let failed = 0;
  const check = (name: string, ok: boolean, detail = ''): void => {
    if (!ok) failed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const rowsOf = (j: any): any[] => (Array.isArray(j) ? j : j?.rows ?? j?.items ?? []);

  const owners: { n: number; token: string; branch: string; productId: string; imei: string }[] = [];
  for (let n = 1; n <= BOUTIQUES; n++) {
    const email = `boutique${n}@test.com`;
    const login = await call('POST', 'auth/login', { body: { identifier: email, password: pw } });
    check(`${email} signs in`, login.status === 200 && Boolean(login.json?.accessToken), String(login.status));
    if (login.status !== 200) continue;
    const token = login.json.accessToken as string;
    const branches = rowsOf((await call('GET', 'auth/branches', { token })).json);
    check(`${email}: one branch, its own`, branches.length === 1 && branches[0].name === `Boutique ${n}`, branches.map((b: any) => b.name).join(', '));
    const branch = branches[0]?.id as string;
    const summary = rowsOf((await call('GET', 'inventory/summary', { token, branch })).json);
    const available = summary.reduce((s: number, r: any) => s + Number(r.available ?? 0), 0);
    const phones = summary.filter((r: any) => r.trackingType === 'imei').reduce((s: number, r: any) => s + Number(r.available ?? 0), 0);
    check(`${email}: exactly 100 available — ${phones} phones, ${available - phones} accessories, ${summary.length} variants`, available === 100, `available ${available}`);
    const list = (await call('GET', 'inventory?status=in_stock&limit=1', { token, branch })).json;
    const firstPhone = summary.find((r: any) => r.trackingType === 'imei');
    const unitList = rowsOf((await call('GET', `inventory?productId=${firstPhone?.productId}&limit=1`, { token, branch })).json);
    owners.push({ n, token, branch, productId: firstPhone?.productId, imei: unitList[0]?.identifier ?? unitList[0]?.imeiPrimary });
    check(`${email}: the unit list agrees (${list?.totals?.units} phones in stock)`, list?.totals?.units === phones, JSON.stringify(list?.totals ?? null));
  }

  // Another boutique's records: never readable.
  for (const me of owners) {
    const other = owners.find((o) => o.n === (me.n % BOUTIQUES) + 1)!;
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
    const platform = await call('GET', 'platform/businesses', { token: me.token });
    if (me.n === 1) check('an Owner has no platform access', platform.status === 401 || platform.status === 403, String(platform.status));
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
  await call('POST', 'platform/admin/sign-out', { cookie, body: {} });

  // The sessions opened here are closed again.
  for (const o of owners) await call('POST', 'auth/logout-all', { token: o.token, body: {} });
  console.log(`\n  ${failed === 0 ? 'all checks passed' : `${failed} check(s) FAILED`}\n`);
  return failed === 0;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const url = qaDatabaseUrl();
  const pw = password();
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const hashing = new HashingService();
  console.log(`\n  QA fixture — schema ${QA_DB}, API ${QA_API}${VERIFY ? '   (verification)' : APPLY ? '' : '   (dry run)'}\n`);

  // The plan, before anything else.
  for (let n = 1; n <= BOUTIQUES; n++) {
    const shelf = shelfFor(n);
    const phones = shelf.reduce((s, l) => s + l.units, 0);
    const accessories = ACCESSORIES.reduce((s, a) => s + a.quantity, 0);
    if (phones + accessories !== 100) throw new Error(`Boutique ${n} would hold ${phones + accessories} units, not 100`);
  }
  const all = new Set<string>();
  for (let n = 1; n <= BOUTIQUES; n++) {
    for (const [index, line] of shelfFor(n).entries()) {
      const model = PHONES.findIndex((p) => p.brand === line.brand && p.model === line.model && p.storage === line.storage);
      for (let u = 0; u < line.units; u++) {
        for (const id of [imeiFor(n, model, index * 10 + u), ...(line.dual && u % 2 === 0 ? [imeiFor(n, model, index * 10 + u, true)] : [])]) {
          if (all.has(id)) throw new Error(`IMEI ${id} would repeat`);
          all.add(id);
        }
      }
    }
    for (let i = 1; i <= ACCESSORIES.length; i++) {
      const code = barcodeFor(n, i);
      if (all.has(code)) throw new Error(`barcode ${code} would repeat`);
      all.add(code);
    }
  }
  console.log(`  plan: ${BOUTIQUES} boutiques × (80 phones + 20 accessories); ${all.size} distinct identifiers (IMEIs and barcodes)`);

  try {
    if (VERIFY) {
      if (!(await verify(pw))) process.exitCode = 1;
      return;
    }
    const admin = await ensureAdmin(prisma, hashing, pw);
    console.log(`  administrator ${ADMIN_EMAIL}: ${admin}`);
    if (!APPLY) {
      console.log('\n  nothing was written. Pass --apply to provision.\n');
      return;
    }

    // The API must serve THIS schema: it has to accept the administrator just written here.
    const signIn = await call('POST', 'platform/admin/sign-in', { body: { email: ADMIN_EMAIL, password: pw } });
    const token = signIn.json?.sessionToken as string | undefined;
    const adminCookie = signIn.cookie ?? (token ? `erp_platform_session=${token}` : null);
    if (signIn.status !== 200 || !adminCookie) throw new Error(`Refusing: the API at ${QA_API} does not serve ${QA_DB} (administrator sign-in: ${signIn.status}).`);

    for (let n = 1; n <= BOUTIQUES; n++) {
      const b = await provisionBoutique(n, prisma, pw, adminCookie);
      const s = await stockBoutique(n, pw);
      console.log(`  Boutique ${n}: ${b.created ? 'registered' : 'present'} · ${s.products} products · ${s.stocked ? 'already stocked' : `${s.phones} phones + ${s.accessories} accessories received`}`);
    }
    await call('POST', 'platform/admin/sign-out', { cookie: adminCookie, body: {} });
    console.log('\n  done.\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`\n  failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});

