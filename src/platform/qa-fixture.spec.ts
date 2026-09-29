import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLOUR_OPTIONS, STORAGE_OPTIONS } from '../catalog/device-attributes';
import { isValidImei } from '../inventory/imei.util';
import {
  ACCESSORIES,
  BOUTIQUES,
  ITEMS_PER_BOUTIQUE,
  PHONES,
  assertQaEnvironment,
  barcodeFor,
  openingKey,
  planFixture,
  privateApiEnvironment,
  qaPassword,
  receiptKey,
  registrationKey,
  resolveQaTarget,
} from '../../scripts/qa-fixture';

/**
 * The QA fixture (`npm run qa:seed`): ten boutiques of 100 items and a platform
 * administrator, in a disposable QA database and nowhere else.
 *
 * The data and the guards are pure and tested directly. The command itself
 * boots an API and talks to a database, so what matters about it — where its
 * API may connect, that no password is written into it — is checked at the
 * source, as `staging-fixture-safety.spec.ts` does for the staging fixture.
 */
describe('the QA fixture', () => {
  describe('the dataset', () => {
    const plan = planFixture();
    const imeis = plan.flatMap((b) => b.units.flat().flatMap((u) => [u.identifier, ...(u.imeiSecondary ? [u.imeiSecondary] : [])]));
    const barcodes = plan.flatMap((b) => ACCESSORIES.map((_, i) => barcodeFor(b.n, i + 1)));

    it('is ten boutiques of exactly 100 items: 80 phones and 20 accessories', () => {
      expect(plan).toHaveLength(BOUTIQUES);
      for (const b of plan) {
        expect([b.n, b.phones, b.accessories]).toEqual([b.n, 80, 20]);
        expect(b.units.flat()).toHaveLength(b.phones);
        expect(b.phones + b.accessories).toBe(ITEMS_PER_BOUTIQUE);
      }
    });

    it('uses only valid IMEIs, and no identifier twice anywhere in the fixture', () => {
      for (const imei of imeis) expect([imei, isValidImei(imei)]).toEqual([imei, true]);
      // 800 first IMEIs, 350 second ones, 60 barcodes.
      expect([imeis.length, barcodes.length]).toEqual([1150, 60]);
      expect(new Set([...imeis, ...barcodes]).size).toBe(imeis.length + barcodes.length);
    });

    it('gives accessories EAN-13 barcodes, which can never be read as an IMEI', () => {
      for (const code of barcodes) {
        expect(code).toMatch(/^\d{13}$/);
        const sum = [...code.slice(0, 12)].reduce((s, c, i) => s + Number(c) * (i % 2 === 0 ? 1 : 3), 0);
        expect(Number(code[12])).toBe((10 - (sum % 10)) % 10);
      }
    });

    it("describes every phone in the app's own vocabulary, priced above its cost", () => {
      const storage = new Set(STORAGE_OPTIONS.filter((o) => o.key !== 'other').map((o) => o.label));
      const colours = new Set(COLOUR_OPTIONS.filter((o) => o.key !== 'other').map((o) => o.label));
      for (const p of PHONES) {
        expect([p.model, storage.has(p.storage), colours.has(p.colour)]).toEqual([p.model, true, true]);
        expect(p.price).toBeGreaterThan(p.cost);
      }
      for (const a of ACCESSORIES) expect(a.price).toBeGreaterThan(a.cost);
    });

    it('is the same dataset on every run, so a rerun recognises what it made', () => {
      expect(planFixture()).toEqual(plan);
      /*
       * Pinned: the fixture 1d6caa0 first provisioned. Changing any of it would
       * leave every existing QA database holding a dataset the command no longer
       * recognises — a rerun would then add a second shelf. Change it only with a
       * new receipt key and a recreated database.
       */
      expect(createHash('sha256').update(JSON.stringify(plan)).digest('hex')).toBe(
        '3d7fc3d3d7b068fd5c92e58b33dd4624226d19f93e1832c479423f327e076e46',
      );
      expect([registrationKey(1), receiptKey(1), openingKey(1)]).toEqual([
        'qa-boutique-1',
        '01a4ea99-4138-4ce3-927b-a1fa0cb55955',
        '66cbe806-abcf-4760-9067-dd239bb94c3d',
      ]);
    });
  });

  describe('where it may run', () => {
    it('accepts a prisma_qa database named outright', () => {
      const target = resolveQaTarget({ QA_DATABASE_URL: 'mysql://migrator:secret@db.local:3310/prisma_qa' });
      expect(target).toEqual({ url: 'mysql://migrator:secret@db.local:3310/prisma_qa', database: 'prisma_qa', server: 'db.local:3310' });
      expect(resolveQaTarget({ QA_DATABASE_URL: 'mysql://m:s@localhost/prisma_qa_team' }).database).toBe('prisma_qa_team');
    });

    it("takes the server from DATABASE_URL but never its database", () => {
      const live = 'mysql://migrator:secret@localhost:3306/phonestore';
      expect(resolveQaTarget({ DATABASE_URL: live })).toMatchObject({ database: 'prisma_qa', url: 'mysql://migrator:secret@localhost:3306/prisma_qa' });
      expect(resolveQaTarget({ DATABASE_URL: live, QA_DB: 'prisma_qa_2' }).database).toBe('prisma_qa_2');
      // QA_DATABASE_URL wins outright.
      expect(resolveQaTarget({ DATABASE_URL: live, QA_DATABASE_URL: 'mysql://q:q@qa-host:3306/prisma_qa' }).server).toBe('qa-host:3306');
    });

    it.each([
      ['the live database', { QA_DATABASE_URL: 'mysql://m:s@localhost:3306/phonestore' }],
      ['the live database through QA_DB', { DATABASE_URL: 'mysql://m:s@localhost:3306/prisma_qa', QA_DB: 'phonestore' }],
      ['a verification copy of live', { QA_DATABASE_URL: 'mysql://m:s@localhost:3306/prisma_verify_home' }],
      ['a name that only starts like one', { QA_DATABASE_URL: 'mysql://m:s@localhost:3306/prisma_qax' }],
      ['a QA name that says live', { QA_DATABASE_URL: 'mysql://m:s@localhost:3306/prisma_qa_live' }],
      ['a QA name that says production', { QA_DATABASE_URL: 'mysql://m:s@localhost:3306/prisma_qa_prod' }],
      ['a QA name that says staging', { QA_DATABASE_URL: 'mysql://m:s@localhost:3306/prisma_qa_staging' }],
      ['a QA name that says demo', { QA_DATABASE_URL: 'mysql://m:s@localhost:3306/prisma_qa_demo' }],
      ['no database at all', {}],
      ['an unresolved variable', { QA_DATABASE_URL: 'mysql://m:${PW}@localhost:3306/prisma_qa' }],
      ['another engine', { QA_DATABASE_URL: 'postgres://m:s@localhost:5432/prisma_qa' }],
      ['something that is not a URL', { QA_DATABASE_URL: 'prisma_qa' }],
    ])('refuses %s', (_, env) => {
      expect(() => resolveQaTarget(env)).toThrow(/Refusing/);
    });

    it('refuses a production or staging environment, whatever the database is called', () => {
      expect(() => assertQaEnvironment({ NODE_ENV: 'production' })).toThrow(/Refusing/);
      expect(() => assertQaEnvironment({ APP_ENV: 'staging' })).toThrow(/Refusing/);
      expect(() => assertQaEnvironment({ APP_ENV: 'Production' })).toThrow(/Refusing/);
      expect(() => assertQaEnvironment({ NODE_ENV: 'development' })).not.toThrow();
    });

    it('takes the password from the environment only, at least 8 characters', () => {
      expect(() => qaPassword({})).toThrow(/QA_PASSWORD/);
      expect(() => qaPassword({ QA_PASSWORD: 'short' })).toThrow(/8 characters/);
      expect(qaPassword({ QA_PASSWORD: 'eight-ch' })).toBe('eight-ch');
    });

    it('gives the private API the QA database and nothing else: no other URL, no password, loopback only', () => {
      const target = resolveQaTarget({ QA_DATABASE_URL: 'mysql://m:s@localhost:3306/prisma_qa' });
      const env = privateApiEnvironment(
        {
          PATH: '/usr/bin',
          DATABASE_URL: 'mysql://m:s@localhost:3306/phonestore',
          APP_DATABASE_URL: 'mysql://app:s@localhost:3306/phonestore',
          SHADOW_DATABASE_URL: 'mysql://m:s@localhost:3306/phonestore_shadow',
          QA_PASSWORD: 'eight-ch',
          OWNER_SEED_PASSWORD: 'x',
          NODE_ENV: 'production',
          API_BIND: '0.0.0.0',
          JWT_ACCESS_SECRET: 'the-live-secret',
        },
        target,
        40123,
        'fresh-secret',
        '/tmp/uploads',
      );
      expect(env).toMatchObject({
        PATH: '/usr/bin',
        APP_DATABASE_URL: target.url,
        DATABASE_URL: target.url,
        NODE_ENV: 'development',
        APP_ENV: '',
        WHATSAPP_CHANNEL: 'disabled',
        API_BIND: '127.0.0.1',
        PORT: '40123',
        JWT_ACCESS_SECRET: 'fresh-secret',
      });
      expect(Object.keys(env).filter((k) => /PASSWORD|SHADOW/.test(k))).toEqual([]);
      expect(Object.entries(env).filter(([, v]) => v?.includes('phonestore'))).toEqual([]);
    });
  });

  describe('the command', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'scripts', 'qa-boutiques.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    it('holds no password: it arrives in QA_PASSWORD and is never printed (docs/21: no default credential)', () => {
      expect(code).toMatch(/qaPassword\(process\.env\)/);
      expect(code).not.toMatch(/admin123/);
      expect(code).not.toMatch(/password\s*[:=]\s*['"][^'"]+['"]/i);
      for (const line of code.split('\n').filter((l) => /console\.(log|error)/.test(l))) {
        expect(line).not.toMatch(/\bpw\b/);
      }
    });

    it('checks and reports without --apply, and starts no API for a dry run', () => {
      expect(code).toMatch(/const APPLY = process\.argv\.includes\('--apply'\)/);
      const dryRun = code.indexOf('if (!APPLY && !VERIFY)');
      expect(dryRun).toBeGreaterThan(-1);
      expect(code.indexOf('startPrivateApi(target)')).toBeGreaterThan(dryRun);
      expect(code.slice(dryRun, code.indexOf('startPrivateApi(target)'))).toMatch(/ensureAdmin\(prisma, hashing, pw, false\)[\s\S]*return;/);
    });

    it('runs its preconditions before anything is written', () => {
      expect(code.indexOf('await preflight(prisma, target)')).toBeLessThan(code.indexOf('ensureAdmin(prisma, hashing, pw, true)'));
    });
  });
});
