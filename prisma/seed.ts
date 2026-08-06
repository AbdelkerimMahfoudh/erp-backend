// ===========================================================================
// Seed — idempotent. Runs as the MIGRATOR user. Two parts:
//   1. Reference data (ALL envs): the 17 permissions.
//   2. Demo data (dev only, SEED_DEMO != "false"): one company + branch + owner,
//      the 5 roles + role->permission matrix, and default settings.
// No application/business logic here — this only populates the database.
//
// MySQL note: primary keys are UUIDv7 BINARY(16). Prisma has no default for
// Bytes ids, so every create supplies one via newUuidV7Bin() (prisma/lib/uuid).
// ===========================================================================

import { config as loadEnv } from 'dotenv';
import { Prisma, PrismaClient, RoleKey, TrackingType } from '@prisma/client';
import * as argon2 from 'argon2';
import { newUuidV7Bin, uuidToBin, binToUuid } from './lib/uuid';
import { generateStoreCode } from '../src/common/utils/store-code.util';
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLE_LABELS,
  DEFAULT_SETTINGS,
  type RoleKey as SeedRoleKey,
} from './seed-data/permissions';

loadEnv(); // load .env before constructing the client
const prisma = new PrismaClient();

// Deterministic demo id → re-running the seed never duplicates.
const DEMO_COMPANY_ID = uuidToBin('018f0000-0000-7000-8000-000000000001');
const DEMO_BRANCH_NAME = 'Main Store';

async function seedPermissions() {
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: p.key },
      update: { label: p.label },
      create: { id: newUuidV7Bin(), key: p.key, label: p.label },
    });
  }
  console.log(`✓ Permissions catalog: ${PERMISSIONS.length} keys`);
}

async function seedDemo() {
  const ownerPassword = process.env.OWNER_SEED_PASSWORD;
  if (!ownerPassword) {
    throw new Error('OWNER_SEED_PASSWORD is required to seed the demo owner user.');
  }

  // 1. Company
  const company = await prisma.company.upsert({
    where: { id: DEMO_COMPANY_ID },
    update: {},
    create: {
      id: DEMO_COMPANY_ID,
      name: 'Demo Phone Store',
      // Public Store Account ID (Stage 3.2). Generated once on create; the
      // `update: {}` above never touches it, so re-seeding cannot change it.
      publicStoreId: generateStoreCode(),
      currency: 'USD',
      timezone: 'UTC',
      settingsJson: {},
    },
  });

  // 2. Branch
  const branch = await prisma.branch.upsert({
    where: { companyId_name: { companyId: company.id, name: DEMO_BRANCH_NAME } },
    update: {},
    create: { id: newUuidV7Bin(), companyId: company.id, name: DEMO_BRANCH_NAME, type: 'store' },
  });

  // 3. Roles + role_permissions
  const permByKey = new Map(
    (await prisma.permission.findMany()).map((p) => [p.key, p.id]),
  );
  const roleByKey = new Map<string, Buffer>();

  for (const key of Object.keys(ROLE_PERMISSIONS) as SeedRoleKey[]) {
    const role = await prisma.role.upsert({
      where: { companyId_key: { companyId: company.id, key: key as RoleKey } },
      update: { name: ROLE_LABELS[key] },
      create: { id: newUuidV7Bin(), companyId: company.id, key: key as RoleKey, name: ROLE_LABELS[key] },
    });
    roleByKey.set(key, role.id);

    for (const permKey of ROLE_PERMISSIONS[key]) {
      const permId = permByKey.get(permKey);
      if (!permId) continue;
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permId } },
        update: {},
        create: { companyId: company.id, roleId: role.id, permissionId: permId },
      });
    }
  }
  console.log(`✓ Roles: ${roleByKey.size} with permission mappings`);

  // 4. Owner user + branch assignment
  const passwordHash = await argon2.hash(ownerPassword, { type: argon2.argon2id });
  const owner = await prisma.user.upsert({
    where: { companyId_login: { companyId: company.id, login: 'owner' } },
    update: {},
    create: { id: newUuidV7Bin(), companyId: company.id, name: 'Demo Owner', login: 'owner', passwordHash },
  });

  const ownerRoleId = roleByKey.get('owner')!;
  await prisma.userBranch.upsert({
    where: { userId_branchId: { userId: owner.id, branchId: branch.id } },
    update: { roleId: ownerRoleId },
    create: { id: newUuidV7Bin(), companyId: company.id, userId: owner.id, branchId: branch.id, roleId: ownerRoleId },
  });

  await remapLegacyRoles(company.id, roleByKey);

  // 5. Default company-wide settings (branch_id NULL). Idempotent via lookup.
  for (const s of DEFAULT_SETTINGS) {
    const existing = await prisma.setting.findFirst({
      where: { companyId: company.id, branchId: null, key: s.key },
    });
    if (existing) {
      await prisma.setting.update({ where: { id: existing.id }, data: { value: s.value as object } });
    } else {
      await prisma.setting.create({
        data: { id: newUuidV7Bin(), companyId: company.id, branchId: null, key: s.key, value: s.value as object },
      });
    }
  }
  console.log(`✓ Default settings: ${DEFAULT_SETTINGS.length} keys`);

  // 5b. Owner-facing business policy (0019). Created with schema defaults so a
  // brand-new company behaves exactly like a migrated one: `GET /settings`
  // answers immediately instead of 404-ing at a shop that has done nothing
  // wrong. `update: {}` keeps an Owner's real choices intact on reseed.
  await prisma.companySettings.upsert({
    where: { companyId: company.id },
    update: {},
    create: { companyId: company.id },
  });
  console.log('✓ Company settings row present');

  // 6. Baseline product categories with adaptive attribute schemas.
  const categories: {
    name: string;
    trackingType: TrackingType;
    schema: Array<Record<string, unknown>>;
  }[] = [
    {
      name: 'Smartphones',
      trackingType: TrackingType.imei,
      schema: [
        { key: 'storage', label: 'Storage', type: 'number', unit: 'GB' },
        { key: 'ram', label: 'RAM', type: 'number', unit: 'GB' },
        { key: 'color', label: 'Color', type: 'text' },
      ],
    },
    {
      name: 'Televisions',
      trackingType: TrackingType.serial,
      schema: [
        { key: 'screen_size', label: 'Screen size', type: 'number', unit: 'in' },
        { key: 'resolution', label: 'Resolution', type: 'enum', options: ['HD', 'FHD', '4K', '8K'] },
        { key: 'panel', label: 'Panel', type: 'enum', options: ['LED', 'OLED', 'QLED'] },
      ],
    },
    { name: 'Accessories', trackingType: TrackingType.quantity, schema: [] },
  ];
  for (const c of categories) {
    await prisma.productCategory.upsert({
      where: { companyId_name: { companyId: company.id, name: c.name } },
      update: { defaultTrackingType: c.trackingType, attributeSchema: c.schema as Prisma.InputJsonValue },
      create: {
        id: newUuidV7Bin(),
        companyId: company.id,
        name: c.name,
        defaultTrackingType: c.trackingType,
        attributeSchema: c.schema as Prisma.InputJsonValue,
      },
    });
  }
  console.log(`✓ Product categories: ${categories.length}`);

  console.log(`✓ Demo company "${company.name}" (${binToUuid(company.id)}) / branch "${branch.name}" / owner login "owner"`);
}

async function main() {
  await seedPermissions();

  if (process.env.SEED_DEMO === 'false') {
    console.log('SEED_DEMO=false → skipping demo data (production-safe).');
  } else {
    await seedDemo();
  }
  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });


/**
 * Remap legacy store roles onto the merged store-facing set (0016).
 *
 *   sales_employee    -> store_employee
 *   warehouse_employee-> store_employee
 *   branch_manager    -> store_manager
 *
 * Only the role value changes: assignment id, company, branch and user are all
 * left untouched, so nothing about who works where is disturbed.
 *
 * Idempotent by construction — it selects assignments that still point at a
 * legacy role, so a second run finds none and does nothing. It never creates
 * or deletes an assignment.
 *
 * Merging sales and warehouse LOSES their original distinction, so the exact
 * before/after mapping is printed. Keep that output with the migration record:
 * the verified database dump is the rollback source, but this tells you which
 * five rows to restore individually.
 */
async function remapLegacyRoles(
  companyId: Buffer,
  roleByKey: Map<string, Buffer>,
): Promise<void> {
  const LEGACY_MAP: Record<string, SeedRoleKey> = {
    sales_employee: 'store_employee',
    warehouse_employee: 'store_employee',
    branch_manager: 'store_manager',
    // `administrator` is intentionally absent: it is an internal SaaS role,
    // not a store-facing one, and must not be swept into this merge.
  };

  const roles = await prisma.role.findMany({ where: { companyId }, select: { id: true, key: true } });
  const byId = new Map(roles.map((r) => [r.id.toString('hex'), r.key as string]));

  const legacyIds = roles.filter((r) => LEGACY_MAP[r.key as string]).map((r) => r.id);
  if (legacyIds.length === 0) return;

  const stale = await prisma.userBranch.findMany({
    where: { companyId, roleId: { in: legacyIds } },
    select: { id: true, userId: true, branchId: true, roleId: true },
  });
  if (stale.length === 0) {
    console.log('✓ Role remap: nothing to do (already migrated)');
    return;
  }

  const users = await prisma.user.findMany({ where: { companyId }, select: { id: true, login: true } });
  const loginById = new Map(users.map((u) => [u.id.toString('hex'), u.login]));

  console.log(`Role remap — ${stale.length} assignment(s):`);
  for (const a of stale) {
    const from = byId.get(a.roleId.toString('hex'))!;
    const to = LEGACY_MAP[from];
    const target = roleByKey.get(to);
    if (!target) throw new Error(`Target role ${to} missing; seed roles before remapping`);

    await prisma.userBranch.update({ where: { id: a.id }, data: { roleId: target } });
    console.log(
      `  assignment=${a.id.toString('hex').slice(0, 8)} user=${loginById.get(a.userId.toString('hex'))} ` +
        `branch=${a.branchId.toString('hex').slice(0, 8)} ${from} -> ${to}`,
    );
  }
}
