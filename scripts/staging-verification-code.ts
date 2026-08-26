// ===========================================================================
// Retrieve the latest STAGING verification code for one contact.
//
//   npx ts-node scripts/staging-verification-code.ts <email-or-number>
//
// **Temporary staging infrastructure.** It exists only because no email or
// WhatsApp provider is configured yet, and it goes when one is. Nothing here
// claims a message was delivered, because nothing delivered one.
//
// Why a server-side command rather than an endpoint:
//
//   - a code returned from an HTTP response would make the whole verification
//     meaningless — anybody could "verify" any address;
//   - a code in a log file is a working credential sitting in a file that gets
//     copied around;
//   - a code on the administration dashboard would put a tester's credential
//     in front of every administrator.
//
// So it requires shell access to the staging box, refuses outside staging, and
// answers about **one contact you already named**. It will not list contacts.
// ===========================================================================

import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';

/*
 * `override` is load-bearing. Do not remove it.
 *
 * `@prisma/client` loads `.env` as a side effect of being imported, and ES
 * imports are evaluated before any statement in this file — so by the time this
 * line runs, `DATABASE_URL` already points at the DEVELOPMENT database, and
 * plain dotenv will not replace a variable that is already set.
 *
 * The result was worse than a plain misconfiguration: `APP_ENV` is absent from
 * `.env`, so it WAS set from `.env.staging` and the staging guard passed, while
 * `DATABASE_URL` was present in `.env` and silently stayed on development. The
 * command believed it was in staging and read the wrong database.
 *
 * `PrismaClient` resolves its URL when it is constructed, not when it is
 * imported, so overriding here is enough.
 */
loadEnv({ path: '.env.staging', override: true });

/**
 * The stored value is a hash, so the code cannot simply be read back.
 *
 * That is the correct design and this script does not weaken it: it re-derives
 * the hash for each candidate code and matches. Six digits is a small enough
 * space to walk, which is exactly why the code is short-lived, single-use and
 * attempt-limited in the first place.
 */
function findCode(destination: string, hash: string): string | null {
  for (let i = 0; i < 1_000_000; i++) {
    const candidate = String(i).padStart(6, '0');
    if (createHash('sha256').update(`${destination}:${candidate}`).digest('hex') === hash) {
      return candidate;
    }
  }
  return null;
}

async function main() {
  /*
   * `APP_ENV` is the authority here, not `NODE_ENV`.
   *
   * Staging deliberately runs with `NODE_ENV=production` so it exercises the
   * same code paths a real deployment would. A `NODE_ENV` check therefore
   * refuses the exact environment this command exists for — which is what the
   * first version of this guard did.
   */
  const appEnv = (process.env.APP_ENV ?? '').toLowerCase();
  if (appEnv !== 'staging') {
    throw new Error(
      `APP_ENV is "${appEnv || 'unset'}", not "staging". This command runs nowhere else.`,
    );
  }

  const raw = process.argv[2]?.trim();
  if (!raw) {
    throw new Error(
      'Usage: npx ts-node scripts/staging-verification-code.ts <email-or-number>\n' +
        'One contact at a time. This command deliberately cannot list them.',
    );
  }

  // The same normalisation the server used when it stored the row, so a number
  // typed the way it is printed still matches.
  const destination = raw.includes('@')
    ? raw.toLowerCase()
    : (await import('../src/auth/identifier')).normalisePhone(raw) ?? raw;

  const prisma = new PrismaClient();
  try {
    const row = await prisma.contactVerification.findFirst({
      where: { destination, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    if (!row) {
      // Deliberately the same answer whether the contact is unknown, the code
      // expired, or it was already used.
      console.log('No unexpired unused code for that contact.');
      return;
    }

    const code = findCode(destination, row.codeHash);
    if (!code) {
      console.log('A code exists but could not be re-derived. It may use a newer format.');
      return;
    }

    console.log('');
    console.log('  contact : ' + destination);
    console.log('  code    : ' + code);
    console.log('  expires : ' + row.expiresAt.toISOString());
    console.log('  attempts: ' + row.attempts);
    console.log('');
    console.log('  Nothing sent this code. No email or WhatsApp provider is configured.');
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
