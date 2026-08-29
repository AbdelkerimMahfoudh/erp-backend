// ===========================================================================
// The retained staging fixture: one shop, one branch, twenty phones.
//
//   npx ts-node scripts/staging-fixture-store.ts                 # reports only
//   FIXTURE_OWNER_PASSWORD=… npx ts-node scripts/staging-fixture-store.ts --apply
//
// Staging accumulates throwaway tenants and the cleanup command deliberately
// cannot remove them. This one is different: it is meant to survive, so there
// is always a shop somebody can sign into and see stock in.
//
// **Every step runs through the real code.** Registration goes through
// `RegistrationService`, so the company, its branch, its Owner, the canonical
// roles and their permission mappings and the pending subscription are created
// exactly as a real signup creates them. Verification goes through the real
// continuation and challenge, so the Owner's contact is verified the way a
// person's is. Activation goes through `SubscriptionLifecycleService`, so the
// grant is audited and attributed. Nothing here writes a shortcut into a table
// that a service is supposed to own.
//
// The password is never in this file, never in a tracked env file, never
// printed and never logged. It arrives in `FIXTURE_OWNER_PASSWORD` or through a
// non-echoing prompt, and is hashed by the ordinary authentication path.
// ===========================================================================

import { config as loadEnv } from 'dotenv';

// `override` is load-bearing: `@prisma/client` loads `.env` as an import side
// effect, before this line runs, and plain dotenv will not replace a variable
// that is already set. Without it the guard passes while the connection stays
// on development. See `scripts/staging-verification-code.ts`.
loadEnv({ path: '.env.staging', override: true });

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { createHash, createInterface } from './fixture-support';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RegistrationService } from '../src/platform/registration.service';
import { RegistrationContinuationService } from '../src/platform/registration-continuation.service';
import { SubscriptionLifecycleService } from '../src/platform/subscription-lifecycle.service';
import { BillingService } from '../src/billing/billing.service';
import { isValidImei, luhnValid } from '../src/inventory/imei.util';
import { newUuidV7Bin, binToUuid } from '../src/common/utils/uuid.util';

// ── Identity of the fixture ────────────────────────────────────────────────
//
// Provenance, so a rerun recognises its own work rather than making a second
// one. The email is the key: it is unique per company and it is what somebody
// types to sign in.
const OWNER_EMAIL = 'store@test.com';
const COMPANY_NAME = 'Test Store';
const BRANCH_NAME = 'Main Store';
const OWNER_NAME = 'Test Owner';
const GRANT_DAYS = 30;
const GRANT_REASON = 'Retained staging demonstration fixture';

const APPLY = process.argv.includes('--apply');

/** The twenty phones. Deterministic, so a rerun produces the same shop. */
interface Phone {
  model: string;
  variant: string;
  colour: string;
  cost: number;
  price: number;
  /** Dual-SIM handsets carry a second IMEI. They are still ONE unit. */
  dual?: boolean;
}

const PHONES: Phone[] = [
  { model: 'iPhone 11', variant: '64 GB', colour: 'Black', cost: 9000, price: 11000 },
  { model: 'iPhone 11', variant: '128 GB', colour: 'White', cost: 10000, price: 12500 },
  { model: 'iPhone 12', variant: '64 GB', colour: 'Blue', cost: 12000, price: 15000 },
  { model: 'iPhone 12 mini', variant: '128 GB', colour: 'Red', cost: 11500, price: 14000 },
  { model: 'iPhone 12 Pro', variant: '256 GB', colour: 'Graphite', cost: 17000, price: 21000, dual: true },
  { model: 'iPhone 13', variant: '128 GB', colour: 'Midnight', cost: 16000, price: 19500 },
  { model: 'iPhone 13 mini', variant: '128 GB', colour: 'Pink', cost: 15000, price: 18000 },
  { model: 'iPhone 13 Pro', variant: '256 GB', colour: 'Sierra Blue', cost: 22000, price: 27000, dual: true },
  { model: 'iPhone 13 Pro Max', variant: '512 GB', colour: 'Gold', cost: 28000, price: 34000 },
  { model: 'iPhone 14', variant: '128 GB', colour: 'Starlight', cost: 20000, price: 24500 },
  { model: 'iPhone 14 Plus', variant: '256 GB', colour: 'Purple', cost: 23000, price: 28000 },
  { model: 'iPhone 14 Pro', variant: '256 GB', colour: 'Deep Purple', cost: 30000, price: 36000, dual: true },
  { model: 'iPhone 14 Pro Max', variant: '512 GB', colour: 'Space Black', cost: 36000, price: 43000 },
  { model: 'iPhone 15', variant: '128 GB', colour: 'Blue', cost: 26000, price: 31500 },
  { model: 'iPhone 15 Plus', variant: '256 GB', colour: 'Yellow', cost: 30000, price: 36000 },
  { model: 'iPhone 15 Pro', variant: '256 GB', colour: 'Natural Titanium', cost: 38000, price: 45000, dual: true },
  { model: 'iPhone 15 Pro Max', variant: '512 GB', colour: 'Blue Titanium', cost: 45000, price: 53000 },
  { model: 'iPhone SE (3rd gen)', variant: '64 GB', colour: 'Midnight', cost: 8000, price: 10000 },
  { model: 'iPhone XR', variant: '128 GB', colour: 'Coral', cost: 7000, price: 9000 },
  { model: 'iPhone XS Max', variant: '256 GB', colour: 'Silver', cost: 8500, price: 10500, dual: true },
];

/**
 * Synthetic IMEIs, generated here and nowhere else.
 *
 * **No real device identifier is copied from anywhere.** The first eight digits
 * are a documented test range rather than a real Type Allocation Code, the next
 * six are a deterministic sequence, and the fifteenth is the Luhn check digit
 * the application's own helper validates. The same run order always produces the
 * same identifiers, which is what makes a rerun a no-op instead of a second
 * shop's worth of stock.
 */
const TEST_TAC = '01000000'; // not an allocated TAC; deliberately synthetic

function withCheckDigit(fourteen: string): string {
  if (!/^\d{14}$/.test(fourteen)) throw new Error(`not 14 digits: ${fourteen}`);
  // The check digit is whatever makes the whole thing Luhn-valid.
  for (let d = 0; d <= 9; d++) {
    const candidate = fourteen + String(d);
    if (luhnValid(candidate)) return candidate;
  }
  throw new Error(`no check digit completes ${fourteen}`);
}

function syntheticImei(index: number, secondary = false): string {
  // Primaries and secondaries occupy disjoint bands, so a primary can never
  // equal a secondary however the list grows.
  const serial = (secondary ? 500_000 : 100_000) + index;
  return withCheckDigit(TEST_TAC + String(serial).padStart(6, '0'));
}

// ── Guards ─────────────────────────────────────────────────────────────────

function assertStaging(): string {
  const appEnv = (process.env.APP_ENV ?? '').toLowerCase();
  if (appEnv !== 'staging') {
    throw new Error(`APP_ENV is "${appEnv || 'unset'}", not "staging". Refusing.`);
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Refusing.');
  if (url.includes('${')) throw new Error('DATABASE_URL has an unresolved variable. Refusing.');

  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name || name === '*') throw new Error('Refusing: empty or wildcard database name.');
  if (!/^[a-z0-9_]*stag(e|ing)[a-z0-9_]*$/i.test(name)) {
    throw new Error(`Refusing: "${name}" is not a staging database name.`);
  }
  for (const forbidden of [/^phonestore$/i, /prod/i, /production/i, /^live$/i, /demo/i]) {
    if (forbidden.test(name)) throw new Error(`Refusing: "${name}" looks protected.`);
  }
  return name;
}

/** Never echoed, never logged, never defaulted. */
async function readPassword(): Promise<string> {
  const fromEnv = process.env.FIXTURE_OWNER_PASSWORD;
  if (fromEnv && fromEnv.length >= 8) return fromEnv;
  if (fromEnv) throw new Error('FIXTURE_OWNER_PASSWORD is too short (8 characters minimum).');

  const rl = createInterface();
  try {
    const answer = await rl.question('Owner password for the staging fixture: ');
    if (!answer || answer.length < 8) throw new Error('Refusing: password too short.');
    return answer;
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const database = assertStaging();
  console.log(`\n  staging fixture — ${database}${APPLY ? '' : '   (dry run)'}\n`);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const prisma = app.get(PrismaService);
  const registration = app.get(RegistrationService);
  const continuation = app.get(RegistrationContinuationService);
  const lifecycle = app.get(SubscriptionLifecycleService);
  const billing = app.get(BillingService);

  try {
    // ── Provenance ─────────────────────────────────────────────────────────
    const existingOwner = await prisma.user.findFirst({
      where: { email: OWNER_EMAIL },
      select: { id: true, companyId: true, emailVerifiedAt: true, company: { select: { name: true } } },
    });

    if (existingOwner && existingOwner.company.name !== COMPANY_NAME) {
      throw new Error(
        `Refusing: ${OWNER_EMAIL} already belongs to "${existingOwner.company.name}", ` +
          `not "${COMPANY_NAME}". This command will not take over an account it did not create.`,
      );
    }

    let companyId: Buffer;
    let ownerId: Buffer;

    if (existingOwner) {
      companyId = existingOwner.companyId;
      ownerId = existingOwner.id;
      console.log(`  company     : ${COMPANY_NAME} — already present, reusing`);
    } else if (!APPLY) {
      console.log(`  company     : ${COMPANY_NAME} — would be created`);
      console.log(`  owner       : ${OWNER_EMAIL} — would be created and verified`);
      console.log(`  branch      : ${BRANCH_NAME}`);
      console.log(`  subscription: would be activated by a ${GRANT_DAYS}-day administrative grant`);
      console.log(`  products    : ${PHONES.length} iPhone variants`);
      console.log(`  units       : ${PHONES.length} in stock (${PHONES.filter((p) => p.dual).length} dual-IMEI)`);
      console.log('\n  nothing was written. Pass --apply to provision.\n');
      return;
    } else {
      const password = await readPassword();

      /*
       * The real registration, so roles, mappings, the branch and the pending
       * subscription are created by the code that owns them.
       */
      const result = await registration.register({
        idempotencyKey: `staging-fixture-${OWNER_EMAIL}`,
        ownerName: OWNER_NAME,
        businessName: COMPANY_NAME,
        branchName: BRANCH_NAME,
        email: OWNER_EMAIL,
        password,
        language: 'en',
      });
      companyId = Buffer.from(result.companyId.replace(/-/g, ''), 'hex');
      ownerId = Buffer.from(result.ownerUserId.replace(/-/g, ''), 'hex');
      console.log(`  company     : ${COMPANY_NAME} created`);
    }

    // ── The Owner's contact, verified the way a person's is ────────────────
    const owner = await prisma.user.findUniqueOrThrow({
      where: { id: ownerId },
      select: { emailVerifiedAt: true },
    });

    if (!owner.emailVerifiedAt) {
      if (!APPLY) {
        console.log('  owner       : contact would be verified');
      } else {
        const issued = await continuation.issue(companyId, ownerId);
        const started = await continuation.startChallenge(issued.token, 'en');
        if (!started.ok) throw new Error(`could not start the challenge: ${started.reason}`);

        // The staging retrieval technique, in-process: the code is not stored,
        // only its hash, so it is recovered the same way the documented command
        // recovers it.
        const row = await prisma.contactVerification.findFirstOrThrow({
          where: { destination: OWNER_EMAIL, consumedAt: null },
          orderBy: { createdAt: 'desc' },
          select: { codeHash: true },
        });
        let code: string | null = null;
        for (let i = 0; i < 1_000_000; i++) {
          const candidate = String(i).padStart(6, '0');
          if (createHash(`${OWNER_EMAIL}:${candidate}`) === row.codeHash) {
            code = candidate;
            break;
          }
        }
        if (!code) throw new Error('could not recover the verification code');

        const done = await continuation.complete(issued.token, code);
        if (!done.ok) throw new Error(`verification failed: ${done.reason}`);
        console.log('  owner       : contact verified');

        /*
         * Completion issues a real session, as it must. The fixture is a shop
         * somebody signs into later, not a live session sitting open, so it is
         * revoked immediately.
         */
        await prisma.authSession.updateMany({
          where: { userId: ownerId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
    } else {
      console.log('  owner       : contact already verified');
    }

    // ── The subscription, through the audited lifecycle ────────────────────
    const subscription = await prisma.subscription.findFirstOrThrow({
      where: { companyId },
      select: { status: true, complimentaryUntil: true },
    });

    if (subscription.status !== 'activated') {
      if (!APPLY) {
        console.log(`  subscription: would be granted ${GRANT_DAYS} days`);
      } else {
        const admin = await prisma.platformAdmin.findFirstOrThrow({
          where: { isActive: true, deletedAt: null },
          select: { id: true, email: true, name: true },
        });
        const granted = await lifecycle.activateByGrant(
          binToUuid(companyId),
          { days: GRANT_DAYS, reason: GRANT_REASON },
          { admin, ip: null },
        );
        /*
         * A grant is complimentary time, not a paid period — it sets
         * `complimentaryUntil`, and `currentPeriodEnd` stays null precisely so
         * nobody can mistake it for a period somebody paid for.
         */
        console.log(
          `  subscription: activated by grant until ` +
            `${granted.subscription.complimentaryUntil?.toISOString().slice(0, 10) ?? 'unknown'}` +
            ' (complimentary — no payment)',
        );
      }
    } else {
      console.log(
        `  subscription: already active until ` +
          `${subscription.complimentaryUntil?.toISOString().slice(0, 10) ?? 'unknown'}` +
          ' (complimentary — no payment)',
      );
    }

    // ── Stock ──────────────────────────────────────────────────────────────
    const branch = await prisma.branch.findFirstOrThrow({
      where: { companyId, isActive: true },
      select: { id: true, name: true },
    });

    let productsCreated = 0;
    let unitsCreated = 0;
    const report: Record<string, string>[] = [];

    for (const [index, phone] of PHONES.entries()) {
      const imei = syntheticImei(index);
      const imeiSecondary = phone.dual ? syntheticImei(index, true) : null;

      // Every identifier is checked by the application's own validator before
      // it can reach a column.
      if (!isValidImei(imei)) throw new Error(`generated an invalid IMEI: ${imei}`);
      if (imeiSecondary && !isValidImei(imeiSecondary)) {
        throw new Error(`generated an invalid secondary IMEI: ${imeiSecondary}`);
      }
      if (imeiSecondary === imei) throw new Error('primary and secondary must differ');

      report.push({
        model: phone.model,
        variant: `${phone.variant} · ${phone.colour}`,
        status: 'in_stock',
        imei,
        imeiSecondary: imeiSecondary ?? '—',
        cost: String(phone.cost),
        price: String(phone.price),
      });

      if (!APPLY) continue;

      const product =
        (await prisma.product.findFirst({
          where: {
            companyId,
            brand: 'Apple',
            model: phone.model,
            variant: `${phone.variant} · ${phone.colour}`,
            deletedAt: null,
          },
          select: { id: true },
        })) ??
        (productsCreated++,
        await prisma.product.create({
          data: {
            id: newUuidV7Bin(),
            companyId,
            brand: 'Apple',
            model: phone.model,
            variant: `${phone.variant} · ${phone.colour}`,
            trackingType: 'imei',
            defaultCost: phone.cost,
            defaultPrice: phone.price,
          },
          select: { id: true },
        }));

      /*
       * Uniqueness is checked across BOTH columns before insertion, because an
       * identifier that already exists as somebody's secondary is just as taken
       * as one that exists as a primary.
       */
      const clash = await prisma.unit.findFirst({
        where: {
          OR: [
            { imeiPrimary: imei },
            { imeiSecondary: imei },
            ...(imeiSecondary
              ? [{ imeiPrimary: imeiSecondary }, { imeiSecondary: imeiSecondary }]
              : []),
          ],
        },
        select: { id: true, companyId: true },
      });

      if (clash) {
        if (!clash.companyId.equals(companyId)) {
          throw new Error(`Refusing: ${imei} already belongs to another company.`);
        }
        continue; // already provisioned by an earlier run
      }

      await prisma.unit.create({
        data: {
          id: newUuidV7Bin(),
          companyId,
          productId: product.id,
          branchId: branch.id,
          imeiPrimary: imei,
          imeiSecondary,
          cost: phone.cost,
          status: 'in_stock',
          dateIn: new Date(),
        },
      });
      unitsCreated++;
    }

    // ── What it costs ──────────────────────────────────────────────────────
    const pricing = await billing.pricingFor(companyId);

    console.log(`  branch      : ${branch.name}`);
    console.log(`  products    : ${productsCreated} created, ${PHONES.length} intended`);
    console.log(`  units       : ${unitsCreated} created, ${PHONES.length} intended`);
    console.log(`  monthly     : ${pricing.quote.monthlyTotal} ${pricing.quote.currency}`);

    console.log('\n  ── synthetic staging fixture inventory ──────────────────');
    console.log('  NOT REAL DEVICES. Every identifier below was generated locally');
    console.log('  from a non-allocated test range and is safe to publish.\n');
    console.log(
      '  ' +
        'Model'.padEnd(22) +
        'Variant'.padEnd(28) +
        'IMEI'.padEnd(17) +
        'IMEI 2'.padEnd(17) +
        'Cost'.padStart(7) +
        'Price'.padStart(8),
    );
    for (const r of report) {
      console.log(
        '  ' +
          r.model.padEnd(22) +
          r.variant.padEnd(28) +
          r.imei.padEnd(17) +
          r.imeiSecondary.padEnd(17) +
          r.cost.padStart(7) +
          r.price.padStart(8),
      );
    }
    console.log(
      `\n  ${PHONES.length} units · ${PHONES.filter((p) => p.dual).length} dual-IMEI ` +
        `· all prices in MRU · no sales, no customers, no expenses\n`,
    );

    if (!APPLY) console.log('  nothing was written. Pass --apply to provision.\n');
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  Logger.error(e instanceof Error ? e.message : String(e), 'StagingFixture');
  process.exitCode = 1;
});
