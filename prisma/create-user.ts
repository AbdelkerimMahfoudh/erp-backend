// ===========================================================================
// One-off dev utility: create (or reset) a staff user for internal testing.
//
// There is no user-management API yet — that lands with the Settings screen in
// Phase 2 — so accounts for testing are created here, against the same tables
// and the same Argon2id hashing the auth service uses.
//
//   npx ts-node prisma/create-user.ts <login> <password> <role> [name]
//
// Idempotent: re-running updates the password and role rather than failing, so
// it doubles as a password reset for a forgotten test account.
// ===========================================================================

import { config as loadEnv } from 'dotenv';
import { PrismaClient, RoleKey } from '@prisma/client';
import * as argon2 from 'argon2';
import { newUuidV7Bin, uuidToBin, binToUuid } from './lib/uuid';

loadEnv();
const prisma = new PrismaClient();

const DEMO_COMPANY_ID = uuidToBin('018f0000-0000-7000-8000-000000000001');

const VALID_ROLES: RoleKey[] = [
  'owner',
  'administrator',
  'branch_manager',
  'sales_employee',
  'warehouse_employee',
];

async function main() {
  const [login, password, roleArg, ...nameParts] = process.argv.slice(2);

  if (!login || !password || !roleArg) {
    throw new Error(
      'Usage: ts-node prisma/create-user.ts <login> <password> <role> [name]\n' +
        `Roles: ${VALID_ROLES.join(' | ')}`,
    );
  }
  if (!VALID_ROLES.includes(roleArg as RoleKey)) {
    throw new Error(`Unknown role "${roleArg}". Expected one of: ${VALID_ROLES.join(', ')}`);
  }

  const roleKey = roleArg as RoleKey;
  const name = nameParts.join(' ') || login;

  const company = await prisma.company.findUnique({ where: { id: DEMO_COMPANY_ID } });
  if (!company) throw new Error('Demo company not found — run the seed first.');

  const role = await prisma.role.findFirst({ where: { companyId: company.id, key: roleKey } });
  if (!role) throw new Error(`Role "${roleKey}" not found for this company — run the seed first.`);

  // Same algorithm and parameters as HashingService, so the auth service can
  // verify what we write here.
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  const user = await prisma.user.upsert({
    where: { companyId_login: { companyId: company.id, login } },
    update: { passwordHash, name, deletedAt: null },
    create: { id: newUuidV7Bin(), companyId: company.id, name, login, passwordHash },
  });

  // Assign to every branch in the company. A user with no branch assignment
  // logs in successfully and then lands on an empty branch picker, which looks
  // like a broken app rather than a permissions decision.
  const branches = await prisma.branch.findMany({ where: { companyId: company.id } });
  if (branches.length === 0) throw new Error('No branches found — run the seed first.');

  for (const branch of branches) {
    await prisma.userBranch.upsert({
      where: { userId_branchId: { userId: user.id, branchId: branch.id } },
      update: { roleId: role.id },
      create: {
        id: newUuidV7Bin(),
        companyId: company.id,
        userId: user.id,
        branchId: branch.id,
        roleId: role.id,
      },
    });
  }

  console.log(
    `✓ User "${login}" (${binToUuid(user.id)}) — role ${roleKey}, ` +
      `${branches.length} branch(es): ${branches.map((b) => b.name).join(', ')}`,
  );
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
