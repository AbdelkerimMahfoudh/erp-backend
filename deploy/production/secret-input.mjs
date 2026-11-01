// Write one provider secret, typed or piped by the operator, into its file under SECRETS_DIR (docs/100 §4).
//
//   <secret on stdin> | node deploy/production/secret-input.mjs <kind> <file>
//
// kinds: whatsapp_app_secret, whatsapp_webhook_verify_token, whatsapp_access_token.
//
// What is normalised, and nothing else: one leading UTF-8 byte-order mark (U+FEFF — Windows PowerShell adds it when
// it pipes text to a native command) and trailing CR/LF. Every other character is kept and judged, so a wrong first
// character is refused, never trimmed away. The value must then match its kind exactly, or nothing is written.
// The previous file is kept beside it as <file>.pre-<UTC> with the same owner and mode; the new one replaces it in
// one rename. Prints the kind and the length, never the value. Exit 1 on a refusal, 2 on a usage error.
import { chmodSync, chownSync, copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const KINDS = {
  // Meta shows the app secret as 32 lowercase hexadecimal characters (App settings → Basic).
  whatsapp_app_secret: { test: (v) => /^[0-9a-f]{32}$/.test(v), rule: '32 lowercase hexadecimal characters' },
  // Ours, generated: long, printable, no spaces (Meta echoes it back in the subscription check).
  whatsapp_webhook_verify_token: { test: (v) => /^[\x21-\x7e]{32,128}$/.test(v), rule: '32 to 128 printable characters without spaces' },
  // A system-user token: "EAA" then letters and digits.
  whatsapp_access_token: { test: (v) => /^EAA[A-Za-z0-9]{40,1000}$/.test(v), rule: '"EAA" followed by 40 to 1000 letters and digits' },
};

/** The normalised value, or an error that names the rule and the length — never the content. */
export function normalizeSecret(raw, kind) {
  const spec = KINDS[kind];
  if (!spec) return { ok: false, why: `unknown kind "${kind}"` };
  let value = raw.startsWith('﻿') ? raw.slice(1) : raw;
  value = value.replace(/[\r\n]+$/, '');
  if (!spec.test(value)) return { ok: false, why: `${kind} must be ${spec.rule} (received ${value.length} characters)` };
  return { ok: true, value };
}

function main(argv) {
  const [kind, file] = argv;
  if (!kind || !file || !KINDS[kind]) {
    console.error(`usage: <secret on stdin> | node secret-input.mjs <${Object.keys(KINDS).join('|')}> <file>`);
    return 2;
  }
  const result = normalizeSecret(readFileSync(0, 'utf8'), kind);
  if (!result.ok) {
    console.error(`Refused: ${result.why}. Nothing was written.`);
    return 1;
  }
  let owner = null;
  if (existsSync(file)) {
    const st = statSync(file);
    owner = { uid: st.uid, gid: st.gid, mode: st.mode & 0o777 };
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    copyFileSync(file, `${file}.pre-${stamp}`);
    chmodSync(`${file}.pre-${stamp}`, owner.mode);
    if (process.getuid?.() === 0) chownSync(`${file}.pre-${stamp}`, owner.uid, owner.gid);
  }
  writeFileSync(`${file}.new`, result.value, { mode: 0o600 });
  if (owner) {
    chmodSync(`${file}.new`, owner.mode);
    if (process.getuid?.() === 0) chownSync(`${file}.new`, owner.uid, owner.gid);
  }
  renameSync(`${file}.new`, file);
  console.log(`stored ${kind} (${result.value.length} characters)${owner ? '; the previous file is kept as a .pre-* copy' : ''}.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
