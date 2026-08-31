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

describe('the individual fixture view', () => {
  /*
   * The third physical test failed 3/3, and part of why is this page: with
   * thirty-two barcodes on it, several are in frame at once and the decoder
   * reports whichever resolves first. A wrong result could then be the
   * scanner's fault or the sheet's, with no way to tell them apart.
   *
   * Physical QA uses the solo view. The grid stays, for choosing a fixture.
   */

  it('gives every code a full-screen view of its own', () => {
    expect(source).toMatch(/const solos: string\[\] = \[\]/);
    expect(source).toMatch(/<section class="solo" id="\$\{slugs\[i\]\}">/);
    expect(source).toMatch(/Open \$\{parts\.length > 1 \? p\.cap : 'this one'\} alone/);
  });

  it('shows exactly one code per view, dual-SIM cards included', () => {
    // Two identifiers on one full-screen page would reintroduce the exact
    // problem the view exists to remove.
    expect(source).toMatch(/const slugs = parts\.map\(\(_, i\) => `fx-\$\{base \+ i \+ 1\}`\)/);
    expect(source).toMatch(/parts\.forEach\(\(p, i\) => \{/);
    expect(source).toMatch(/ONE code per solo view, even for a dual-SIM card/);
  });

  it('regenerates no identifier — the grid and the solo view share their bytes', () => {
    // `parts` is built once and both views read from it, so the two cannot
    // disagree by construction rather than by luck.
    expect(source).toMatch(/\/\/ Built once, used in both views\./);
    expect(source).toMatch(/grid: barcodeSvg\(c\.value, c\.height \?\? 48\)/);
    expect(source).toMatch(/solo: barcodeSvg\(c\.value, \(c\.height \?\? 48\) \* 2\)/);
  });

  it('carries the expected result and a way back', () => {
    expect(source).toMatch(/<a class="back" href="#top">/);
    expect(source).toMatch(/<body id="top">/);
    expect(source).toMatch(/<p class="expect"><span>Expected<\/span>/);
  });

  it('uses CSS alone — no script, and nothing off the machine', () => {
    // Staging-only and entirely local, exactly like the rest of the sheet.
    expect(source).toMatch(/\.solo \{ display: none; \}/);
    expect(source).toMatch(/\.solo:target \{/);
    expect(source).not.toMatch(/<script/i);
    expect(source).toMatch(/no script, no framework and no\s+\* network/);
  });

  it('leaves a wide quiet margin and high contrast', () => {
    // A barcode needs clear space to decode, and a generous one also keeps
    // anything else out of shot.
    expect(source).toMatch(/padding: 6vmin 8vmin;/);
    expect(source).toMatch(/The quiet margin\./);
    expect(source).toMatch(/background: #fff;/);
  });

  it('does not print — the solo views are a screen tool', () => {
    expect(source).toMatch(/@media print \{ \.solo, \.alone \{ display: none !important; \} \}/);
  });
});

describe('case 12 — the one card that can actually be booked in', () => {
  /*
   * Every other IMEI on this sheet already exists in Test Store. Scanning one
   * proves recognition, and can never prove that adding a phone moves the
   * shelf: the duplicate is refused long before it gets that far. Case 12 is
   * the only card that closes that loop on a real device.
   */

  it('is built from the fixture TAC, so recognition resolves it to a stocked model', () => {
    expect(source).toMatch(/const tac = \(first\.imeiPrimary \?\? ''\)\.slice\(0, 8\)/);
    expect(source).toContain('12 · A phone that is NOT yet in stock');
  });

  it('computes a real check digit rather than inventing one', () => {
    // A test caught exactly this mistake once already, on this same sheet: an
    // invented secondary IMEI whose check digit was wrong.
    expect(source).toMatch(/function luhnCheckDigit/);
    expect(source).toMatch(/luhnCheckDigit\(fourteen\)/);
  });

  it('asks the database instead of assuming the serial is free', () => {
    // A card that claims "not yet in stock" and turns out to be a duplicate
    // tests the opposite of what it says, and fails as a pass.
    expect(source).toMatch(/imeiPrimary: candidate/);
    expect(source).toMatch(/if \(inUse === 0\)/);
    // A count rather than a row: this script reads no database id at all, and
    // the assertion above about labels depends on that staying true.
    expect(source).toMatch(/prisma\.unit\.count/);
    expect(source).toMatch(/Could not build an unused synthetic IMEI/);
  });

  it('says what the count must do, both times it is scanned', () => {
    expect(source).toMatch(/count goes from N to N\+1/);
    expect(source).toMatch(/refused as a duplicate, and the count does not move/);
  });

  it('invents no identifier of its own — the TAC comes from the fixture', () => {
    // The rule for this whole sheet: synthetic identifiers only, and never one
    // retrieved from anywhere. The TAC is read from a fixture unit, the serial
    // is arbitrary, the check digit is computed.
    const case12 = source.slice(source.indexOf('const tac ='), source.indexOf('const tempCard') + 1 || undefined);
    expect(case12).not.toMatch(/\b\d{15}\b/);
  });
});
