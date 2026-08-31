// ===========================================================================
// A printable scan sheet for the staging fixture.
//
//   APP_ENV=staging npx ts-node scripts/staging-scan-sheet.ts > sheet.html
//
// **This is not camera verification.** It is the thing somebody needs in order
// to do camera verification: a page of the fixture's synthetic identifiers as
// scannable codes, so a real phone can be pointed at them.
//
// Nothing here proves the scanner works. Only a phone does that, and until one
// has been used `docs/24` says so.
//
// Staging only. It refuses elsewhere, because a sheet of barcodes that resolve
// to real inventory is a way to book in stock nobody received.
// ===========================================================================

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.staging', override: true });

import { PrismaClient } from '@prisma/client';
import { isValidImei } from '../src/inventory/imei.util';

/**
 * Code 128 (subset B), drawn as SVG bars.
 *
 * Hand-rolled rather than pulled from a package: this is a staging convenience
 * that must never reach the application bundle, and adding a dependency to the
 * backend so a test sheet can print would be a poor trade. The encoding is
 * small and entirely mechanical.
 */
const CODE128B = [
  '11011001100','11001101100','11001100110','10010011000','10010001100','10001001100',
  '10011001000','10011000100','10001100100','11001001000','11001000100','11000100100',
  '10110011100','10011011100','10011001110','10111001100','10011101100','10011100110',
  '11001110010','11001011100','11001001110','11011100100','11001110100','11101101110',
  '11101001100','11100101100','11100100110','11101100100','11100110100','11100110010',
  '11011011000','11011000110','11000110110','10100011000','10001011000','10001000110',
  '10110001000','10001101000','10001100010','11010001000','11000101000','11000100010',
  '10110111000','10110001110','10001101110','10111011000','10111000110','10001110110',
  '11101110110','11010001110','11000101110','11011101000','11011100010','11011101110',
  '11101011000','11101000110','11100010110','11101101000','11101100010','11100011010',
  '11101111010','11001000010','11110001010','10100110000','10100001100','10010110000',
  '10010000110','10000101100','10000100110','10110010000','10110000100','10011010000',
  '10011000010','10000110100','10000110010','11000010010','11001010000','11110111010',
  '11000010100','10001111010','10100111100','10010111100','10010011110','10111100100',
  '10011110100','10011110010','11110100100','11110010100','11110010010','11011011110',
  '11011110110','11110110110','10101111000','10100011110','10001011110','10111101000',
  '10111100010','11110101000','11110100010','10111011110','10111101110','11101011110',
  '11110101110','11010000100','11010010000','11010011100','11000111010',
];
const START_B = 104;
const STOP = '1100011101011';

function code128(text: string): string {
  const values = [START_B, ...[...text].map((c) => c.charCodeAt(0) - 32)];
  const checksum = values.reduce((sum, v, i) => sum + v * (i === 0 ? 1 : i), 0) % 103;
  return values.map((v) => CODE128B[v]).join('') + CODE128B[checksum] + STOP;
}

function barcodeSvg(text: string, height = 56): string {
  const bits = code128(text);
  const w = 1.6;
  let x = 0;
  const bars: string[] = [];
  for (const bit of bits) {
    if (bit === '1') bars.push(`<rect x="${x.toFixed(2)}" y="0" width="${w}" height="${height}"/>`);
    x += w;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${x.toFixed(0)}" height="${height}" viewBox="0 0 ${x.toFixed(0)} ${height}" fill="#000">${bars.join('')}</svg>`;
}


/**
 * Negative and special fixtures.
 *
 * Every one of these is generated here and **never written to a database**. An
 * invalid checksum, a wrong length, an ICCID or an EID exist so the scanner can
 * be seen REFUSING them; a fixture that could be booked into inventory would
 * defeat its own purpose.
 */
function breakCheckDigit(imei: string): string {
  // One digit different, so the length is right and the checksum is not — the
  // near-miss a real mistyped IMEI looks like.
  const last = Number(imei[14]);
  return imei.slice(0, 14) + String((last + 1) % 10);
}

/** EAN-13 check digit: 1,3,1,3… weighting. */
function ean13(twelve: string): string {
  const sum = [...twelve].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return twelve + String((10 - (sum % 10)) % 10);
}

/**
 * A synthetic ICCID and EID.
 *
 * Both are printed on a phone or its packaging beside the IMEI, and both are
 * long strings of digits — which is exactly why they get scanned by mistake. An
 * ICCID identifies a SIM, an EID identifies an eSIM chip, and neither is an
 * IMEI. `89` is the telecom major industry identifier; the rest is invented.
 */
const SYNTHETIC_ICCID = '8988303000000000001';
const SYNTHETIC_EID = '89049032000000000000000000000001';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

async function main(): Promise<void> {
  /*
   * Check the DATABASE, not the flag.
   *
   * This file loads `.env.staging` itself, so testing `APP_ENV` here would be
   * testing a variable this script just set — a guard that can never fail is
   * not a guard. What matters is which database the sheet is about to read, so
   * that is what gets checked, with the same rule the cleanup and fixture
   * commands use.
   */
  const name = new URL(process.env.DATABASE_URL ?? 'mysql://x/none').pathname.replace(/^\/+/, '');
  if (!/^[a-z0-9_]*stag(e|ing)[a-z0-9_]*$/i.test(name)) {
    throw new Error(`Refusing: "${name}" is not a staging database.`);
  }
  for (const forbidden of [/^phonestore$/i, /prod/i, /^live$/i, /demo/i]) {
    if (forbidden.test(name)) throw new Error(`Refusing: "${name}" looks protected.`);
  }

  const prisma = new PrismaClient();
  try {
    const units = await prisma.unit.findMany({
      where: { company: { name: 'Test Store' } },
      select: {
        imeiPrimary: true,
        imeiSecondary: true,
        product: { select: { brand: true, model: true, variant: true } },
      },
      orderBy: { imeiPrimary: 'asc' },
    });

    if (units.length === 0) throw new Error('No Test Store units found. Run the fixture command first.');
    for (const u of units) {
      if (u.imeiPrimary && !isValidImei(u.imeiPrimary)) {
        throw new Error(`Refusing: ${u.imeiPrimary} is not a valid IMEI.`);
      }
    }

    /*
     * Two phones whose TACs disagree, for the conflict case; a valid IMEI on a
     * TAC nothing maps, for the unknown case. Both are built from the fixture's
     * own identifiers so nothing new is invented.
     */
    const first = units[0];
    const dual = units.find((u) => u.imeiSecondary) ?? units[0];
    const conflictA = units[0].imeiPrimary!;
    const conflictB = units.find((u) => u.imeiPrimary !== conflictA)!.imeiPrimary!;

    // A valid IMEI whose TAC (09990999) is deliberately in no catalogue.
    const unknownBase = '0999099910000';
    const unknownTacImei = (() => {
      for (let d = 0; d <= 9; d++) {
        const candidate = unknownBase + '0' + String(d);
        if (isValidImei(candidate)) return candidate;
      }
      throw new Error('could not build an unknown-TAC IMEI');
    })();

    const card = (opts: {
      title: string;
      expect: string;
      tone?: 'good' | 'refuse';
      codes: { cap: string; value: string; height?: number }[];
      note?: string;
    }) => `<article class="${opts.tone === 'refuse' ? 'refuse' : ''}">
  <h2>${esc(opts.title)}</h2>
  ${opts.codes
    .map(
      (c) =>
        `<div class="cap">${esc(c.cap)}</div>${barcodeSvg(c.value, c.height ?? 48)}<div class="num">${esc(c.value)}</div>`,
    )
    .join('')}
  ${opts.note ? `<p class="note">${esc(opts.note)}</p>` : ''}
  <p class="expect"><span>Expected</span> ${esc(opts.expect)}</p>
</article>`;

    // ── The twenty stock phones ───────────────────────────────────────────
    const stock = units
      .map((u) => {
        const label = [u.product.brand, u.product.model, u.product.variant].filter(Boolean).join(' ');
        const codes: { cap: string; value: string; height?: number }[] = [
          { cap: 'IMEI 1', value: u.imeiPrimary ?? '' },
        ];
        if (u.imeiSecondary) codes.push({ cap: 'IMEI 2', value: u.imeiSecondary, height: 40 });
        return card({
          title: label,
          codes,
          expect: u.imeiSecondary
            ? 'Apple + this model, as a suggestion. Both codes find the SAME one phone.'
            : 'Apple + this model, as a suggestion you still confirm.',
        });
      })
      .join(String.fromCharCode(10));

    // ── The cases that are not ordinary stock ─────────────────────────────
    const special = [
      card({
        title: '1 · Raw IMEI, no label',
        codes: [{ cap: 'Code 128', value: first.imeiPrimary ?? '' }],
        expect: `Recognised as Apple ${first.product.model}. A bare 15-digit code is still an IMEI.`,
      }),
      /*
       * Cases 2 and 3 need QR, and QR needs an encoder this repository does not
       * have. Code 128 is small and entirely mechanical, so it is hand-rolled
       * above; QR needs Reed–Solomon error correction, masking and format
       * information, and a hand-rolled one that LOOKS right but does not decode
       * would be worse than none — it would be a fixture that fails a test the
       * scanner actually passed.
       *
       * Left visible rather than silently absent: a printed sheet that is
       * quietly missing two of the ten cases is a sheet somebody signs off as
       * complete.
       */
      `<article class="pending">
  <h2>2 · Labelled single IMEI in QR</h2>
  <h2>3 · One QR carrying IMEI1 and IMEI2</h2>
  <p class="note">Not on this sheet yet. Both need a QR encoder, and a
  hand-rolled one that cannot be verified here would be a fixture that fails a
  test the scanner passed.</p>
  <p class="expect"><span>Pending</span> add a QR encoder, then regenerate.</p>
</article>`,
      card({
        title: '4 · Same phone, both SIMs',
        codes: [
          { cap: 'IMEI 1', value: dual.imeiPrimary ?? '' },
          { cap: 'IMEI 2', value: dual.imeiSecondary ?? '', height: 40 },
        ],
        expect: 'Either code finds the SAME existing unit. One phone, never two.',
      }),
      card({
        title: '5 · Two phones, disagreeing TACs',
        codes: [
          { cap: 'Phone A', value: conflictA },
          { cap: 'Phone B', value: conflictB, height: 40 },
        ],
        note: 'Scan these as if they were IMEI 1 and IMEI 2 of one handset.',
        expect: 'No automatic selection. It must ASK which phone this is.',
      }),
      card({
        title: '6 · Valid IMEI, unknown TAC',
        codes: [{ cap: 'TAC 09990999', value: unknownTacImei }],
        expect: 'Accepted as an identifier, but NO brand and NO model guessed.',
      }),
      card({
        title: '7 · Invalid checksum',
        tone: 'refuse',
        codes: [{ cap: 'One digit wrong', value: breakCheckDigit(first.imeiPrimary ?? '') }],
        note: 'Right length, wrong check digit — what a mistyped IMEI looks like.',
        expect: 'REFUSED as not a valid IMEI. Never stored.',
      }),
      card({
        title: '8 · Wrong length',
        tone: 'refuse',
        codes: [{ cap: '14 digits', value: (first.imeiPrimary ?? '').slice(0, 14) }],
        expect: 'REFUSED. An IMEI is exactly 15 digits.',
      }),
      card({
        title: '9 · ICCID — a SIM, not a phone',
        tone: 'refuse',
        codes: [{ cap: 'ICCID (19 digits)', value: SYNTHETIC_ICCID }],
        note: 'Printed beside the IMEI, which is why it gets scanned by mistake.',
        expect: 'NOT accepted as an IMEI.',
      }),
      card({
        title: '10 · EID — an eSIM chip, not a phone',
        tone: 'refuse',
        codes: [{ cap: 'EID (32 digits)', value: SYNTHETIC_EID }],
        expect: 'NOT accepted as an IMEI.',
      }),
      card({
        title: '11 · Ordinary product barcode',
        codes: [{ cap: 'EAN-13', value: ean13('600123450000') }],
        note: 'A charger or a case — the everyday non-phone scan.',
        expect: 'Treated as a product barcode. Never as an IMEI.',
      }),
    ].join(String.fromCharCode(10));

    const rows = `<h3>Cases to test</h3><div class="grid">${special}</div>
<h3>Stock — the twenty phones in Test Store</h3><div class="grid">${stock}</div>`;

    process.stdout.write(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Staging scan sheet — SYNTHETIC TEST DATA</title>
<style>
  /*
   * Pinned light, deliberately. A dark-mode browser renders black bars on a
   * dark card, and a barcode without contrast does not scan — which would make
   * this sheet useless for the one job it has.
   */
  :root { color-scheme: light; }
  html, body { background: #fff; }
  body { font: 14px/1.4 system-ui, sans-serif; margin: 24px; color: #111; }
  .warn { border: 2px solid #b45309; background: #fffbeb; padding: 12px 16px;
          border-radius: 8px; margin-bottom: 20px; }
  .warn strong { display: block; font-size: 16px; margin-bottom: 4px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 18px; }
  article { border: 1px solid #d4d4d8; border-radius: 8px; padding: 12px;
            background: #fff; break-inside: avoid; }
  h2 { font-size: 14px; margin: 0 0 8px; }
  .cap { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: #71717a; }
  .num { font-family: ui-monospace, monospace; font-size: 13px; letter-spacing: .06em; margin-top: 2px; }
  h3 { font-size: 15px; margin: 26px 0 10px; padding-bottom: 6px;
       border-bottom: 1px solid #d4d4d8; }
  article.refuse { border-color: #b45309; background: #fffdf7; }
  article.pending { border-style: dashed; background: #fafafa; }
  .note { font-size: 12px; color: #52525b; margin: 8px 0 0; }
  .expect { font-size: 12px; margin: 8px 0 0; padding-top: 8px;
            border-top: 1px dashed #d4d4d8; color: #18181b; }
  .expect span { display: inline-block; font-size: 10px; letter-spacing: .08em;
                 text-transform: uppercase; color: #71717a; margin-right: 6px; }
  @media print { .warn { border-color: #000; } body { margin: 8mm; } }
</style></head><body>
<div class="warn">
  <strong>Synthetic staging fixture — not real devices</strong>
  Every identifier below was generated locally from a non-allocated test range
  and is Luhn-valid by construction. None of them belongs to a real handset.
  They exist so a phone can be pointed at something during scanner testing.
  <br><br>
  <strong>Printing this sheet is not verification.</strong>
  Nothing is proved until a camera has actually read these codes and the result
  has been checked. Until then <code>docs/24</code> records camera verification
  as pending.
</div>
${rows}
</body></html>
`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
