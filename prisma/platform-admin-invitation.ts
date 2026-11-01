/* eslint-disable no-console */
// ===========================================================================
// A new platform administrator, invited — from the server only (0115).
//
// Run through deploy/production/admin-invitation.sh, never directly: the wrapper
// takes the setup code from this program's standard output straight into a
// mode-600 handover file and prints only that file's path. Run by hand, `issue`
// and `resume` refuse to print a code at all.
//
//   issue  <email> <name…>   a new, invited administrator (refused if the address exists in any state)
//   resume <email>           a new setup code for an invitation not yet active (expired code, abandoned enrolment)
//   revoke <email>           withdraw an invitation not yet active
//   status <admin-id-hex>    "pending" while the code can still be spent, else "done" (the wrapper's sweep)
//
// Never touches an active administrator: every command refuses one. Never
// prints a password, a secret or a recovery code; the code goes to the wrapper
// only, as one line on standard output; everything else goes to standard error.
// ===========================================================================

import '../src/common/config/load-secret-files';
import { config as loadEnv } from 'dotenv';

loadEnv();

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PlatformAdminInvitationService, type IssuedInvitation } from '../src/platform/platform-admin-invitation.service';

const say = (line: string) => console.error(line);

function handOver(issued: IssuedInvitation): void {
  if (process.env.ADMIN_INVITATION_HANDOVER !== '1' || process.stdout.isTTY) {
    // Nothing is printed: the code exists only in the database's keyed digest, so this invitation cannot be used.
    throw new Error('Run this through deploy/production/admin-invitation.sh, which writes the code to its handover file. Resume the invitation there.');
  }
  process.stdout.write(`CODE ${issued.adminId} ${issued.expiresAt.toISOString()} ${issued.code}\n`);
}

async function main(): Promise<void> {
  const [command, arg, ...rest] = process.argv.slice(2);
  const usage = 'Usage: platform-admin-invitation.ts issue <email> <name…> | resume <email> | revoke <email> | status <admin-id-hex>';
  if (!command || !arg) throw new Error(usage);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const invitations = app.get(PlatformAdminInvitationService);
    switch (command) {
      case 'issue': {
        if (process.env.ADMIN_INVITATION_HANDOVER !== '1' || process.stdout.isTTY) throw new Error('Run this through deploy/production/admin-invitation.sh. Nothing was created.');
        const issued = await invitations.issue({ email: arg, name: rest.join(' ') });
        handOver(issued);
        say(`Invited ${arg.trim().toLowerCase()}: setup code valid until ${issued.expiresAt.toISOString()}. No other administrator was touched.`);
        break;
      }
      case 'resume': {
        if (process.env.ADMIN_INVITATION_HANDOVER !== '1' || process.stdout.isTTY) throw new Error('Run this through deploy/production/admin-invitation.sh. Nothing was changed.');
        const issued = await invitations.resume(arg);
        handOver(issued);
        say(`New setup code for ${arg.trim().toLowerCase()}, valid until ${issued.expiresAt.toISOString()}; the previous code and any enrolment in progress are void.`);
        break;
      }
      case 'revoke':
        await invitations.revoke(arg);
        say(`Invitation for ${arg.trim().toLowerCase()} withdrawn: the account is disabled, its code void.`);
        break;
      case 'status':
        process.stdout.write(`${await invitations.status(arg)}\n`);
        break;
      default:
        throw new Error(usage);
    }
  } finally {
    await app.close();
  }
}

main().catch((e: unknown) => {
  console.error(`\n  ✗ ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
