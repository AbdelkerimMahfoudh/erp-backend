/* eslint-disable no-console */
// ===========================================================================
// Prove SMTP delivery from THIS deployment (D200, docs/100 §7).
//
//   npx ts-node --transpile-only scripts/email-prove.ts \
//     --recipient-file /run/proof/recipient --brevo-tracking-off-confirmed [--language en|fr|ar]
//
// Sends ONE `delivery.check` email through the reviewed SMTP channel (Brevo, port 587, STARTTLS required, debug off):
// no code, no link, no data — it says it is a delivery test and that nothing is required. The owner then confirms it
// arrived. One message per run; nothing here loops, schedules or retries.
//
// Who receives it is not an argument: the address is read from a private file (mode 600), so it is in no shell
// history and no process list, and it is printed only masked. Who sends it is fixed: Dukan ERP
// <verification@tsxmr.com>, Reply-To support@tsxmr.com. The SMTP login and key arrive as files too
// (SMTP_USERNAME_FILE, SMTP_PASSWORD_FILE): nothing secret is in this process's arguments or in `docker inspect`.
//
// `--brevo-tracking-off-confirmed` is the operator saying the owner confirmed Brevo's open and click tracking are
// off for transactional email: our message carries no link and no image of ours, and Brevo must add none either.
// ===========================================================================
import { loadSecretFiles } from '../src/common/config/secret-files';

loadSecretFiles(process.env);

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { maskEmail } from '../src/messaging/email-channel';
import { emailProofConfig, proofReference, readProofRecipient } from '../src/messaging/email-delivery-proof';
import { SmtpEmailChannel } from '../src/messaging/smtp-email-channel';
import type { MessageLanguage } from '../src/messaging/whatsapp-channel';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const value = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const known = new Set(['--recipient-file', '--brevo-tracking-off-confirmed', '--language']);
  const unknown = args.filter((a, i) => a.startsWith('--') && !known.has(a) && !(i > 0 && ['--recipient-file', '--language'].includes(args[i - 1])));
  if (unknown.length) {
    console.error(`Unknown option(s): ${unknown.join(' ')}`);
    return 2;
  }
  if (!args.includes('--brevo-tracking-off-confirmed')) {
    console.error('Refusing: confirm first that Brevo open and click tracking are off for transactional email (--brevo-tracking-off-confirmed).');
    return 2;
  }
  const file = value('--recipient-file');
  if (!file) {
    console.error('Usage: email-prove.ts --recipient-file <path> --brevo-tracking-off-confirmed [--language en|fr|ar]');
    return 2;
  }
  const language = (value('--language') ?? 'en') as MessageLanguage;
  if (!['en', 'fr', 'ar'].includes(language)) {
    console.error('--language must be en, fr or ar.');
    return 2;
  }

  const to = readProofRecipient(readFileSync(file, 'utf8'));
  const channel = new SmtpEmailChannel(emailProofConfig(process.env));
  const result = await channel.send({ to, template: 'delivery.check', language, variables: {}, idempotencyKey: `delivery-proof-${randomUUID()}` });
  if (result.status === 'accepted') {
    console.log(`email delivery proof: accepted by the relay for ${maskEmail(to)} (${language}) · provider message ${proofReference(result.providerMessageId)}`);
    console.log('Next: the owner confirms it arrived (and where: inbox or spam).');
    return 0;
  }
  console.log(`email delivery proof: FAILED for ${maskEmail(to)} (${language}) · ${result.reason}: ${result.detail}`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    // An error message here is ours (recipient file, configuration), never the transport's: it names no secret.
    console.error(`email delivery proof: refused — ${(e as Error).message}`);
    process.exit(1);
  });
