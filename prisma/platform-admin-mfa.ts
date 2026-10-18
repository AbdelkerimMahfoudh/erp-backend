/* eslint-disable no-console */
// ===========================================================================
// A platform administrator's second factor — from the server only (0094).
//
//   npx ts-node prisma/platform-admin-mfa.ts enrolment-token <email>
//
// Resets the administrator's TOTP factor — every session and recovery code
// goes with it — and prints a one-time ENROLMENT TOKEN, valid thirty minutes.
// The administrator signs in with their password, enters the token, scans the
// key into an authenticator app and confirms with its first code.
//
// This is the only way to enrol or re-enrol. A password alone can never bind
// an authenticator: whoever enrols must also hold a token that only somebody
// with shell access to the server could issue. The token is printed once and
// stored only as a keyed digest; it is never logged.
//
// Needs PLATFORM_MFA_KEY in the environment, as the API does.
// ===========================================================================

// Secrets given as files (NAME_FILE, the production tools container) must be in place before the configuration is
// imported and validated (D200).
import '../src/common/config/load-secret-files';
import { config as loadEnv } from 'dotenv';

loadEnv();

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PlatformMfaService } from '../src/platform/platform-mfa.service';

async function main(): Promise<void> {
  const [command, email] = process.argv.slice(2);
  if (command !== 'enrolment-token' || !email) {
    throw new Error('Usage: npx ts-node prisma/platform-admin-mfa.ts enrolment-token <email>');
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const { token, expiresAt } = await app.get(PlatformMfaService).issueEnrolmentToken(email);
    console.log(`\n  Second factor reset for ${email.trim().toLowerCase()}: every session and recovery code was revoked.`);
    console.log(`  Enrolment token (once, valid until ${expiresAt.toISOString()}):\n\n    ${token}\n`);
    console.log('  Give it to the administrator over a channel you trust; they enter it after signing in.\n');
  } finally {
    await app.close();
  }
}

main().catch((e: unknown) => {
  console.error(`\n  ${(e as Error).message}\n`);
  process.exitCode = 1;
});
