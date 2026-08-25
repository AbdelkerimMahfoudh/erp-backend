// ===========================================================================
// Bootstrap a PLATFORM administrator.
//
//   npx ts-node prisma/create-platform-admin.ts <email> <name>
//
// The password is NOT a command-line argument. Arguments land in shell history
// and in the process list, where anybody on the box can read them; this reads
// from the `PLATFORM_ADMIN_PASSWORD` environment variable instead, so the
// secret never appears in either.
//
//   PLATFORM_ADMIN_PASSWORD='…' npx ts-node prisma/create-platform-admin.ts you@example.com "Your Name"
//
// There is deliberately no HTTP route that does this, and **no default
// credential anywhere in this repository**. A platform administrator can reach
// every business on the platform; the only way to create one is to already have
// shell access to the server.
//
// Re-running for an existing address resets that administrator's password and
// revokes their sessions, so it doubles as the recovery path.
// ===========================================================================

import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { newUuidV7Bin } from './lib/uuid';

loadEnv();
const prisma = new PrismaClient();

async function main() {
  const [emailRaw, ...nameParts] = process.argv.slice(2);
  const password = process.env.PLATFORM_ADMIN_PASSWORD;

  if (!emailRaw || nameParts.length === 0) {
    throw new Error(
      'Usage: PLATFORM_ADMIN_PASSWORD=… npx ts-node prisma/create-platform-admin.ts <email> <name>',
    );
  }
  if (!password) {
    throw new Error(
      'Set PLATFORM_ADMIN_PASSWORD in the environment. It is deliberately not a command-line argument.',
    );
  }
  if (password.length < 12) {
    // Longer than the tenant minimum on purpose: this account administers every
    // business on the platform, and it is typed by one of us, not by a shop.
    throw new Error('Use a password of at least 12 characters for a platform administrator.');
  }

  const email = emailRaw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('That does not look like an email address.');
  }

  const name = nameParts.join(' ');
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  const existing = await prisma.platformAdmin.findUnique({ where: { email } });

  if (existing) {
    await prisma.platformAdmin.update({
      where: { email },
      data: { passwordHash, name, isActive: true, deletedAt: null },
    });
    // A password reset that left old sessions alive would not be a reset.
    const revoked = await prisma.platformAdminSession.updateMany({
      where: { adminId: existing.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    console.log(`✓ Reset platform administrator ${email} — ${revoked.count} session(s) revoked.`);
    return;
  }

  await prisma.platformAdmin.create({
    data: { id: newUuidV7Bin(), email, name, passwordHash },
  });
  console.log(`✓ Created platform administrator ${email}.`);
  console.log('  This account belongs to no company and holds no store role.');
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
