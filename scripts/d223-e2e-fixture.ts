/* eslint-disable no-console */
/**
 * D223 journeys — the fictional business on the DISPOSABLE database erp_inv_e2e.
 *
 * Refuses unless DATABASE_URL names erp_inv_e2e on 127.0.0.1. Registers one fictional business through the product's
 * own RegistrationService (built-in categories included), activates its subscription, and adds a Store Manager and a
 * Store Employee directly (the WhatsApp invitation cannot run here). Passwords are generated and written to
 * d223-e2e-credentials.json in D223_E2E_DIR (default: the OS temp folder, never a repository); nothing is printed.
 *
 *   DATABASE_URL=mysql://root@127.0.0.1:3308/erp_inv_e2e APP_DATABASE_URL=… \n *     npx ts-node --transpile-only scripts/d223-e2e-fixture.ts
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { RegistrationService } from '../src/platform/registration.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { generatePersonalId } from '../src/auth/identifier';
import { newUuidV7Bin } from '../src/common/utils/uuid.util';

async function main(): Promise<number> {
  if (!/@127\.0\.0\.1:3308\/erp_inv_e2e$/.test(process.env.DATABASE_URL ?? '')) {
    console.error('Refusing: this fixture runs against erp_inv_e2e on 127.0.0.1:3308 only.');
    return 2;
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const prisma = app.get(PrismaService);
    const passwords = { owner: randomBytes(18).toString('base64url'), manager: randomBytes(18).toString('base64url'), employee: randomBytes(18).toString('base64url') };
    const reg: any = await app.get(RegistrationService).register({
      idempotencyKey: 'd223-e2e-1',
      ownerName: 'Fictional Owner',
      businessName: 'D223 Fictional Electronics',
      branchName: 'Fictional Main',
      activity: 'electronics',
      city: 'Nouakchott',
      email: 'owner@d223-e2e.example',
      password: passwords.owner,
      language: 'en',
      actor: 'd223-e2e-fixture',
    } as never);
    const company = await prisma.company.findFirstOrThrow({ where: { name: 'D223 Fictional Electronics' } });
    const branch = await prisma.branch.findFirstOrThrow({ where: { companyId: company.id } });
    const owner = await prisma.user.findFirstOrThrow({ where: { companyId: company.id } });
    const until = new Date(Date.now() + 365 * 24 * 3600 * 1000);
    await prisma.subscription.updateMany({
      where: { companyId: company.id },
      data: { status: 'activated', isComplimentary: true, complimentaryReason: 'D223 disposable journeys', complimentaryUntil: until, currentPeriodEnd: until },
    });

    const staff: Record<string, string> = { owner: owner.personalId };
    for (const [who, roleKey] of [['manager', 'store_manager'], ['employee', 'store_employee']] as const) {
      const role = await prisma.role.findFirstOrThrow({ where: { companyId: company.id, key: roleKey } });
      const existing = await prisma.user.findFirst({ where: { companyId: company.id, name: `Fictional ${who}` } });
      const user =
        existing ??
        (await prisma.user.create({
          data: {
            id: newUuidV7Bin(),
            companyId: company.id,
            name: `Fictional ${who}`,
            login: `${who}-d223-e2e`,
            personalId: generatePersonalId(),
            passwordHash: await argon2.hash(passwords[who], { type: argon2.argon2id }),
            isActive: true,
            activatedAt: new Date(),
          },
        }));
      if (!existing) {
        await prisma.userBranch.create({ data: { id: newUuidV7Bin(), companyId: company.id, userId: user.id, branchId: branch.id, roleId: role.id } });
      }
      staff[who] = user.personalId;
    }
    const categories = await prisma.productCategory.count({ where: { companyId: company.id, key: { not: null } } });
    writeFileSync(
      join(process.env.D223_E2E_DIR ?? tmpdir(), 'd223-e2e-credentials.json'),
      JSON.stringify({ branchId: Buffer.from(branch.id).toString('hex'), personalIds: staff, passwords }, null, 2),
    );
    console.log(`fixture ready: registered=${Boolean(reg)}, built-in categories=${categories}, staff=${Object.keys(staff).join(',')}`);
    return 0;
  } finally {
    await app.close();
  }
}

main().then((code) => process.exit(code), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
