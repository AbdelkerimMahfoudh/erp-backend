/* eslint-disable no-console */
// ===========================================================================
// The disposable rehearsal's fictitious businesses (docs/100 §9).
//
//   docker compose … --profile tools run --rm --no-deps tools \
//     npx ts-node --transpile-only scripts/rehearsal-fixture.ts [count]
//
// Creates `count` (default 3, at most 10) fictitious businesses through the product's own provisioning —
// RegistrationService.register, exactly what registration and the platform's "create a business" do: the company, its
// first branch, the roles with their permissions, the Owner and a pending subscription. The rehearsal's backup and
// restore drills then compare real tenant rows, BINARY(16) keys and an audit chain, and the identity checks run their
// trigger probes.
//
// Fictitious only: every name says "Rehearsal", every contact is on the reserved `.example` domain (RFC 2606), the
// passwords are random and discarded, and provisioning sends no message. Idempotent by request key. No business is made
// eligible for a free trial (absent is false).
//
// **It refuses anywhere but the rehearsal**: DEPLOY_PROFILE must be `rehearsal` and the stack's host a *.localhost name
// (the compose file gives both to the tools container, from stack.env, which lib.sh holds to the profile's rules).
// ===========================================================================
import { loadSecretFiles } from '../src/common/config/secret-files';

loadSecretFiles(process.env);

import { NestFactory } from '@nestjs/core';
import { randomBytes } from 'node:crypto';
import { AppModule } from '../src/app.module';
import type { Activity } from '../src/entitlement/activity';
import { RegistrationService } from '../src/platform/registration.service';

const ACTIVITIES: Activity[] = ['electronics', 'money_agent', 'both'];
const LANGUAGES = ['en', 'fr', 'ar'] as const;

async function main(): Promise<number> {
  if (process.env.DEPLOY_PROFILE !== 'rehearsal' || !/\.localhost$/.test(process.env.EXPECTED_API_HOST ?? '')) {
    console.error('Refusing: rehearsal-fixture.ts runs in the disposable rehearsal only (DEPLOY_PROFILE=rehearsal, a *.localhost host).');
    return 2;
  }
  const count = Math.min(10, Math.max(1, Number(process.argv[2] ?? 3) || 3));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const registration = app.get(RegistrationService);
    for (let i = 1; i <= count; i++) {
      const result = await registration.register({
        idempotencyKey: `rehearsal-fixture-${i}`,
        ownerName: `Rehearsal Owner ${i}`,
        businessName: `Rehearsal Boutique ${i}`,
        branchName: 'Rehearsal Main',
        activity: ACTIVITIES[(i - 1) % ACTIVITIES.length],
        city: 'Nouakchott',
        email: `owner${i}@rehearsal.example`,
        password: randomBytes(24).toString('base64url'),
        language: LANGUAGES[(i - 1) % LANGUAGES.length],
        actor: 'rehearsal-fixture',
        note: 'Fictitious business of the disposable rehearsal (docs/100 §9).',
      });
      console.log(`business ${i}: ${result.created ? 'created' : 'already there'} · ${result.activity} · ${result.status}`);
    }
  } finally {
    await app.close();
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`rehearsal fixture: refused — ${(e as Error).message}`);
    process.exit(1);
  });
