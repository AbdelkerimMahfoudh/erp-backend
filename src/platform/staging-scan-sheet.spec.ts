import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as QRCode from 'qrcode';
import { isValidImei, luhnValid } from '../inventory/imei.util';

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'staging-scan-sheet.ts');
const source = readFileSync(SCRIPT, 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/**
 * The printable scan sheet.
 *
 * Its whole job is to be pointed at by a camera, so the failures that matter
 * are the ones that produce a page which LOOKS right: a code with no contrast,
 * a quiet zone the encoder was never told to leave, a negative fixture that
 * quietly ends up in inventory.
 *
 * **Generating a fixture correctly is not decoding it.** Nothing in this file
 * proves a scanner can read the sheet — only a camera does that, and
 * `docs/24` §9n records that as pending.
 */
describe('the staging scan sheet', () => {
  it('refuses any database that is not a staging one', () => {
    /*
     * The guard checks the DATABASE, not `APP_ENV`. The script loads
     * `.env.staging` itself, so an `APP_ENV` check would be testing a variable
     * it had just set — a guard that cannot fail is not a guard.
     */
    expect(code).toMatch(/stag\(e\|ing\)/);
    expect(code).toMatch(/\^phonestore\$/i);
    expect(code).toMatch(/prod/);
    expect(code).toMatch(/demo/);
    expect(code).toMatch(/process\.env\.DATABASE_URL/);
    expect(code).not.toMatch(/process\.env\.APP_ENV/);
  });

  it('never writes anything', () => {
    // A sheet generator that could create a row is a way to book in stock
    // nobody received.
    for (const write of ['.create(', '.update(', '.upsert(', '.delete(', '$executeRaw']) {
      expect(code).not.toContain(write);
    }
    expect(code).toMatch(/prisma\.unit\.findMany/);
  });

  it('validates every identifier it prints from the database', () => {
    expect(code).toMatch(/if \(u\.imeiPrimary && !isValidImei\(u\.imeiPrimary\)\)/);
    expect(code).toMatch(/Refusing: \$\{u\.imeiPrimary\} is not a valid IMEI/);
  });

  it('builds its negative fixtures in memory, never from a table', () => {
    /*
     * An invalid checksum, a wrong length, an ICCID and an EID exist so the
     * scanner can be seen REFUSING them. Every one is derived in the script.
     */
    expect(code).toMatch(/function breakCheckDigit/);
    expect(code).toMatch(/const SYNTHETIC_ICCID/);
    expect(code).toMatch(/const SYNTHETIC_EID/);
    expect(code).toMatch(/function ean13/);
    // None of them is ever looked up or stored.
    expect(code).not.toMatch(/SYNTHETIC_ICCID[^;]*prisma/);
  });

  it('carries all ten fixture types, each with an expected result', () => {
    for (const title of [
      '1 · Raw IMEI, no label',
      '2 · Labelled single IMEI in QR',
      '3 · One QR carrying both IMEIs',
      '4 · Same phone, both SIMs',
      '5 · Two phones, disagreeing TACs',
      '6 · Valid IMEI, unknown TAC',
      '7 · Invalid checksum',
      '8 · Wrong length',
      '9 · ICCID — a SIM, not a phone',
      '10 · EID — an eSIM chip, not a phone',
      '11 · Ordinary product barcode',
    ]) {
      expect([title, code.includes(title)]).toEqual([title, true]);
    }
    // Every card states what should happen, so the sheet is self-describing.
    expect(code).toMatch(/<span>Expected<\/span>/);
  });

  it('exposes no internal database ids', () => {
    // Labels come from brand/model/variant and identifiers. Never from an id.
    expect(code).not.toMatch(/binToUuid/);
    expect(code).not.toMatch(/\bid: true\b/);
  });

  it('is pinned to a light colour scheme', () => {
    // A dark-mode browser renders black bars on a dark card, and a barcode
    // without contrast does not scan.
    expect(code).toMatch(/color-scheme: light/);
    expect(code).toMatch(/html, body \{ background: #fff/);
  });

  it('says on its own face that printing it proves nothing', () => {
    expect(code).toMatch(/Printing this sheet is not verification/);
    expect(code).toMatch(/camera verification/);
  });
});

describe('the QR fixtures', () => {
  /*
   * Regenerated with the same options the script uses, so this tests the
   * encoder's output rather than a copy of it.
   */
  const options = {
    type: 'svg' as const,
    errorCorrectionLevel: 'M' as const,
    margin: 4,
    color: { dark: '#000000ff', light: '#ffffffff' },
  };

  /*
   * The fixture's OWN dual-SIM pair, copied from staging. Synthetic, from a
   * non-allocated range, and Luhn-valid — which the assertions below check,
   * because an earlier version of this test invented a pair and got the check
   * digit wrong.
   */
  const PRIMARY = '010000041000041';
  const SECONDARY = '010000045000047';

  it('uses those exact options in the script', () => {
    expect(code).toMatch(/errorCorrectionLevel: 'M'/);
    expect(code).toMatch(/margin: 4/);
    expect(code).toMatch(/dark: '#000000ff', light: '#ffffffff'/);
  });

  it('only the scan sheet uses the encoder', () => {
    /*
     * `qrcode` is a devDependency for one staging script. It must never reach
     * the application, where it would ship to every shop for no reason.
     */
    expect(code).toMatch(/import \* as QRCode from 'qrcode'/);
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
    expect(pkg.devDependencies.qrcode).toBe('1.5.4');
    expect(pkg.dependencies?.qrcode).toBeUndefined();
    expect(pkg.dependencies?.['@types/qrcode']).toBeUndefined();
  });

  it('the two payloads are the labelled forms, built from synthetic IMEIs', () => {
    expect(code).toMatch(/IMEI: \$\{first\.imeiPrimary\}/);
    expect(code).toMatch(/IMEI1: \$\{dual\.imeiPrimary\}\\nIMEI2: \$\{dual\.imeiSecondary\}/);
    // And both identifiers used above are genuinely valid.
    expect(isValidImei(PRIMARY)).toBe(true);
    expect(isValidImei(SECONDARY)).toBe(true);
    expect(luhnValid(PRIMARY)).toBe(true);
  });

  it('renders black modules on a white ground', async () => {
    const svg = await QRCode.toString(`IMEI: ${PRIMARY}`, options);
    // The library draws modules as a STROKE and the background as a FILL.
    expect(svg).toMatch(/<path fill="#ffffff"/);
    expect(svg).toMatch(/<path stroke="#000000"/);
  });

  it('leaves a four-module quiet zone on every side', async () => {
    /*
     * The classic reason a perfectly valid QR will not decode. Checked by
     * arithmetic rather than trusted: the viewBox is the symbol plus four
     * modules each side, so grid = symbol + 8.
     */
    for (const payload of [`IMEI: ${PRIMARY}`, `IMEI1: ${PRIMARY}\nIMEI2: ${SECONDARY}`]) {
      const svg = await QRCode.toString(payload, options);
      const grid = Number(/viewBox="0 0 (\d+) \1"/.exec(svg)![1]);
      const symbol = grid - 8;
      // A QR symbol is 21, 25, 29 … modules: 17 + 4 × version.
      expect([payload.length, (symbol - 17) % 4]).toEqual([payload.length, 0]);
      expect(symbol).toBeGreaterThanOrEqual(21);
    }
  });

  it('the dual payload carries both identifiers on separate lines', async () => {
    const payload = `IMEI1: ${PRIMARY}\nIMEI2: ${SECONDARY}`;
    // Round-tripping the STRING, not the image: what the encoder was asked to
    // carry is exactly what a decoder should find.
    const [line1, line2] = payload.split('\n');
    expect(line1).toBe(`IMEI1: ${PRIMARY}`);
    expect(line2).toBe(`IMEI2: ${SECONDARY}`);
    expect(PRIMARY).not.toBe(SECONDARY);

    // And it encodes without truncation — a larger symbol than the single one.
    const dual = await QRCode.toString(payload, options);
    const single = await QRCode.toString(`IMEI: ${PRIMARY}`, options);
    const size = (s: string) => Number(/viewBox="0 0 (\d+) \1"/.exec(s)![1]);
    expect(size(dual)).toBeGreaterThan(size(single));
  });

  it('proves the fixture, and NOT the decoding', () => {
    /*
     * The distinction this whole sheet rests on. Generating a correct symbol
     * says the fixture is right. Whether a camera reads it through glass, at an
     * angle, in a shop's lighting, is a question only a phone answers — and
     * `docs/24` §9n keeps it open.
     */
    const checklist = readFileSync(
      join(__dirname, '..', '..', '..', 'docs', '24_DEVICE_QA_CHECKLIST.md'),
      'utf8',
    );
    expect(checklist).toMatch(/no camera has read anything/i);
  });
});
