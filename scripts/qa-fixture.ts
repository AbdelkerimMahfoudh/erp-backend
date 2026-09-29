// ===========================================================================
// The QA fixture's data and its guards — pure: no database, no network.
//
// `scripts/qa-boutiques.ts` is the command; this is what it provisions and the
// rules that keep it in a QA database. Kept apart so the spec
// (`src/platform/qa-fixture.spec.ts`) can check both without booting anything.
//
// **The dataset never changes shape silently.** Every name, key and identifier
// below is deterministic, and it is the same fixture `1d6caa0` provisioned: a
// QA database seeded by that version is recognised by this one, and a rerun
// adds nothing to it.
// ===========================================================================

import { createHash } from 'node:crypto';
import { isValidImei, luhnValid } from '../src/inventory/imei.util';

export const BOUTIQUES = 10;
export const ITEMS_PER_BOUTIQUE = 100;
export const ADMIN_EMAIL = 'admin@test.com';
export const ADMIN_NAME = 'QA Platform Administrator';
export const GRANT_DAYS = 365;
export const GRANT_REASON = 'QA fixture — ten test boutiques (scripts/qa-boutiques.ts)';
export const CITY = 'Nouakchott';
export const PHONES_CATEGORY = 'Smartphones';
export const ACCESSORIES_CATEGORY = 'Accessories';

export const boutiqueEmail = (n: number): string => `boutique${n}@test.com`;
export const boutiqueName = (n: number): string => `Boutique ${n}`;
export const ownerName = (n: number): string => `Owner Boutique ${n}`;
/** The registration's idempotency key: a rerun is answered with the company it already made. */
export const registrationKey = (n: number): string => `qa-boutique-${n}`;
export const receiptReference = (n: number): string => `QA-B${n}-STOCK`;

// ── Where it may run ───────────────────────────────────────────────────────

/**
 * A QA database is named `prisma_qa` or `prisma_qa_<something>`. The name is
 * the contract: the migrator's documented grant (`prisma\_%`,
 * `prisma/sql/init/00_roles.sql`) covers it, and the live schema can never match.
 */
export const QA_DATABASE_NAME = /^prisma_qa(_[a-z0-9_]+)?$/;
const PROTECTED_NAME = [/^phonestore$/i, /stag/i, /prod/i, /live/i, /demo/i];

export interface QaTarget {
  /** The full connection string — never printed, it carries a password. */
  url: string;
  database: string;
  /** `host:port`, safe to print. */
  server: string;
}

/**
 * The one database this command may touch.
 *
 * `QA_DATABASE_URL` names it outright. Without it, `DATABASE_URL` (the
 * backend's `.env`) supplies the server and credentials and `QA_DB` (default
 * `prisma_qa`) the database — the database part of `DATABASE_URL` itself is
 * always replaced, never used.
 */
export function resolveQaTarget(env: NodeJS.ProcessEnv): QaTarget {
  const explicit = env.QA_DATABASE_URL?.trim();
  const source = explicit ? 'QA_DATABASE_URL' : 'DATABASE_URL';
  const raw = explicit || env.DATABASE_URL?.trim();
  if (!raw) {
    throw new Error('Refusing: set QA_DATABASE_URL (or DATABASE_URL, whose database is replaced by QA_DB).');
  }
  if (raw.includes('${')) throw new Error(`Refusing: ${source} has an unresolved variable.`);

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Refusing: ${source} is not a connection URL.`);
  }
  if (url.protocol !== 'mysql:') throw new Error(`Refusing: ${source} is not a mysql:// URL.`);
  if (!explicit) url.pathname = `/${env.QA_DB?.trim() || 'prisma_qa'}`;

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!QA_DATABASE_NAME.test(database)) {
    throw new Error(`Refusing: "${database}" is not a QA database — its name must be prisma_qa or prisma_qa_<suffix>.`);
  }
  for (const forbidden of PROTECTED_NAME) {
    if (forbidden.test(database)) throw new Error(`Refusing: "${database}" looks protected.`);
  }
  return { url: url.toString(), database, server: `${url.hostname}:${url.port || '3306'}` };
}

/** Not on a production or staging deployment, whatever the database is called. */
export function assertQaEnvironment(env: NodeJS.ProcessEnv): void {
  if ((env.NODE_ENV ?? '').trim().toLowerCase() === 'production') {
    throw new Error('Refusing: NODE_ENV is production. The QA fixture never runs on a deployment.');
  }
  const appEnv = (env.APP_ENV ?? '').trim().toLowerCase();
  if (appEnv === 'production' || appEnv === 'staging') {
    throw new Error(`Refusing: APP_ENV is ${appEnv}. The QA fixture never runs on a deployment.`);
  }
}

/**
 * The environment of the command's private API: the caller's, minus every
 * database URL and every password in it, plus the QA database for both the
 * runtime and Prisma. Values set here beat anything the API's own `.env`
 * loading finds, so no other database is reachable from that process.
 */
export function privateApiEnvironment(
  env: NodeJS.ProcessEnv,
  target: QaTarget,
  port: number,
  tokenSecret: string,
  uploadDir: string,
): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/DATABASE_URL$|PASSWORD/i.test(key)) continue;
    kept[key] = value;
  }
  return {
    ...kept,
    // The development contact outbox: no code or message can leave this machine.
    NODE_ENV: 'development',
    APP_ENV: '',
    WHATSAPP_CHANNEL: 'disabled',
    PORT: String(port),
    API_BIND: '127.0.0.1',
    API_INGRESS: '',
    APP_DATABASE_URL: target.url,
    DATABASE_URL: target.url,
    JWT_ACCESS_SECRET: tokenSecret,
    SWAGGER_ENABLED: 'false',
    CORS_ORIGINS: '',
    LOG_LEVEL: 'warn',
    // Private to the command, so its own limits never slow it down. The public routes keep theirs.
    THROTTLE_LIMIT: '100000',
    AUTH_THROTTLE_LIMIT: '100000',
    UPLOAD_DIR: uploadDir,
  };
}

/**
 * The fixture's one password, for all eleven accounts.
 *
 * Only ever from the environment: no default credential exists in this
 * repository (docs/21, platform administrators). Eight characters is the
 * registration minimum; the QA administrator may be shorter than the twelve
 * `create-platform-admin.ts` asks of a real one because it exists only in a
 * QA database.
 */
export function qaPassword(env: NodeJS.ProcessEnv): string {
  const value = env.QA_PASSWORD;
  if (!value) throw new Error('Set QA_PASSWORD in the environment. It is never a command-line argument.');
  if (value.length < 8) throw new Error('QA_PASSWORD must have at least 8 characters (the registration minimum).');
  return value;
}

// ── Deterministic identities ───────────────────────────────────────────────

/** A request key derived from a name, so a rerun sends the same key and is answered with what was done. */
export function keyFor(name: string): string {
  const h = createHash('sha256').update(`qa-boutiques:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The receipt's request key — also how a rerun knows the boutique is already stocked. */
export const receiptKey = (n: number): string => keyFor(`boutique-${n}-stock-v1`);
export const openingKey = (n: number): string => keyFor(`boutique-${n}-opening`);

function checkDigit14(fourteen: string): string {
  for (let d = 0; d <= 9; d++) if (luhnValid(fourteen + d)) return fourteen + d;
  throw new Error(`no check digit completes ${fourteen}`);
}

/**
 * Synthetic IMEIs — no real device identifier is copied. The TAC is `0199`, the boutique and the model (a range no
 * allocation uses here), the serial runs per unit, and the fifteenth digit is the Luhn check the app validates.
 * A second IMEI sits in a disjoint serial band, so it never equals any first IMEI.
 */
export function imeiFor(boutique: number, model: number, unit: number, secondary = false): string {
  const tac = `0199${String(boutique).padStart(2, '0')}${String(model).padStart(2, '0')}`;
  const serial = String((secondary ? 500_000 : 100_000) + unit).padStart(6, '0');
  const imei = checkDigit14(tac + serial);
  if (!isValidImei(imei)) throw new Error(`generated an invalid IMEI ${imei}`);
  return imei;
}

/** EAN-13 in the in-store range (`29…`): thirteen digits, so never an IMEI, and distinct per boutique and product. */
export function barcodeFor(boutique: number, item: number): string {
  const twelve = `29${String(boutique).padStart(3, '0')}${String(item).padStart(7, '0')}`;
  const sum = [...twelve].reduce((s, c, i) => s + Number(c) * (i % 2 === 0 ? 1 : 3), 0);
  return twelve + ((10 - (sum % 10)) % 10);
}

// ── The shelf ──────────────────────────────────────────────────────────────

export interface PhoneModel {
  brand: string;
  model: string;
  storage: string;
  colour: string;
  cost: number;
  price: number;
  /** A second IMEI on every other unit of this variant (dual-SIM handsets; still one unit each). */
  dual?: boolean;
}

export interface PhoneLine extends PhoneModel {
  /** How many of this exact variant the boutique holds. */
  units: number;
}

/**
 * Thirty variants; each boutique takes 26 of them (a different window), 80 units in all. MRU, as the shops price.
 * Brand and model are the device catalogue's own names; storage and colour its canonical labels.
 */
export const PHONES: readonly PhoneModel[] = [
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
export const DEPTHS: readonly number[] = [6, 6, 5, 5, 4, 4, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1];

export interface AccessoryLine {
  brand: string;
  model: string;
  variant: string;
  cost: number;
  price: number;
  quantity: number;
}

/** Twenty pieces over six products. */
export const ACCESSORIES: readonly AccessoryLine[] = [
  { brand: 'Anker', model: 'PowerCore 10000', variant: 'Black', cost: 700, price: 950, quantity: 4 },
  { brand: 'Apple', model: 'USB-C Power Adapter', variant: '20W', cost: 550, price: 800, quantity: 3 },
  { brand: 'Samsung', model: 'Super Fast Charger', variant: '25W', cost: 450, price: 650, quantity: 3 },
  { brand: 'Anker', model: 'USB-C to Lightning Cable', variant: '1m', cost: 200, price: 350, quantity: 4 },
  { brand: 'Generic', model: 'Tempered Glass', variant: 'iPhone 13/14', cost: 60, price: 150, quantity: 3 },
  { brand: 'Generic', model: 'Silicone Case', variant: 'iPhone 15 · Black', cost: 90, price: 250, quantity: 3 },
];

export const phoneVariant = (line: PhoneModel): string => `${line.storage} · ${line.colour}`;

export function shelfFor(boutique: number): PhoneLine[] {
  // A different window over the thirty variants for each boutique, and a different order of depths.
  const start = ((boutique - 1) * 3) % PHONES.length;
  const picked = Array.from({ length: DEPTHS.length }, (_, i) => PHONES[(start + i) % PHONES.length]);
  const rotate = (boutique - 1) % DEPTHS.length;
  return picked.map((p, i) => ({ ...p, units: DEPTHS[(i + rotate) % DEPTHS.length] }));
}

export interface PlannedUnit {
  identifier: string;
  imeiSecondary?: string;
}

/** The units of one shelf line, exactly as the receipt sends them. */
export function unitsFor(boutique: number, index: number, line: PhoneLine): PlannedUnit[] {
  const model = PHONES.findIndex((p) => p.brand === line.brand && p.model === line.model && p.storage === line.storage);
  if (model < 0) throw new Error(`${line.brand} ${line.model} is not in the shelf's model list`);
  return Array.from({ length: line.units }, (_, u) => ({
    identifier: imeiFor(boutique, model, index * 10 + u),
    ...(line.dual && u % 2 === 0 ? { imeiSecondary: imeiFor(boutique, model, index * 10 + u, true) } : {}),
  }));
}

export interface BoutiquePlan {
  n: number;
  shelf: PhoneLine[];
  units: PlannedUnit[][];
  phones: number;
  accessories: number;
}

/**
 * The whole dataset, checked before anything is written: 100 items per boutique, every IMEI valid, and no
 * identifier — first IMEI, second IMEI or barcode — used twice anywhere in the fixture.
 */
export function planFixture(): BoutiquePlan[] {
  const seen = new Set<string>();
  const claim = (id: string, what: string): void => {
    if (seen.has(id)) throw new Error(`${what} ${id} would repeat`);
    seen.add(id);
  };
  const accessories = ACCESSORIES.reduce((s, a) => s + a.quantity, 0);
  return Array.from({ length: BOUTIQUES }, (_, i) => {
    const n = i + 1;
    const shelf = shelfFor(n);
    const units = shelf.map((line, index) => unitsFor(n, index, line));
    for (const unit of units.flat()) {
      claim(unit.identifier, 'IMEI');
      if (unit.imeiSecondary) claim(unit.imeiSecondary, 'second IMEI');
    }
    ACCESSORIES.forEach((_, index) => claim(barcodeFor(n, index + 1), 'barcode'));
    const phones = shelf.reduce((s, l) => s + l.units, 0);
    if (phones + accessories !== ITEMS_PER_BOUTIQUE) {
      throw new Error(`${boutiqueName(n)} would hold ${phones + accessories} items, not ${ITEMS_PER_BOUTIQUE}`);
    }
    return { n, shelf, units, phones, accessories };
  });
}
