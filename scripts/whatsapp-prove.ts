/* eslint-disable no-console */
// ===========================================================================
// Prove WhatsApp delivery on THIS deployment (correction phase, 2026-10-12;
// docs/64, src/messaging/delivery-readiness.ts).
//
//   npm run whatsapp:prove -- --to +2223XXXXXXX     send the delivery check in en, fr and ar
//   npm run whatsapp:prove -- --status              what is proven, what is missing
//
// A production deployment sends no WhatsApp message — no sign-in code, no
// deletion code, no invitation — until each of en, fr and ar has a DELIVERED
// proof for the configured sending number. This command makes the sends (to the
// operator's own number, with the approved `delivery.check` template); the
// provider's signed delivery report, received by the webhook, completes each
// proof. Nothing here can mark a proof delivered, and nothing here is an
// attestation an operator could type.
//
// D181 §4: it runs ONLY in test mode (WHATSAPP_MODE=test) and ONLY to a number
// listed in WHATSAPP_TEST_RECIPIENTS — so readiness is established without
// enabling live sends, and no real customer is ever reached from here.
//
// Prints a masked number only, never a token, never a provider payload.
// Reads the environment the API reads (`.env`, or the deployment's own).
// ===========================================================================

import { config as loadEnv } from 'dotenv';

loadEnv({ override: false });

import { NestFactory } from '@nestjs/core';
import { randomBytes, randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { WHATSAPP_GOVERNED_CHANNEL, isCloudChannel, sendControlsFrom } from '../src/messaging/messaging.module';
import { AppConfigService } from '../src/common/config/app-config.service';
import { PROOF_LANGUAGES, WhatsAppReadiness } from '../src/messaging/delivery-readiness';
import { DELIVERY_CHECK_TEMPLATE } from '../src/messaging/templates';
import { maskDestination } from '../src/messaging/channels';
import { normalisePhone } from '../src/auth/identifier';
import { newUuidV7Bin } from '../src/common/utils/uuid.util';
import type { WhatsAppChannel } from '../src/messaging/whatsapp-channel';

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const prisma = app.get(PrismaService);
    const readiness = app.get(WhatsAppReadiness);
    const channel = app.get<WhatsAppChannel>(WHATSAPP_GOVERNED_CHANNEL);
    const config = app.get(AppConfigService);

    if (process.argv.includes('--status')) {
      await readiness.refresh();
      const proofs = await prisma.messagingDeliveryProof.findMany({
        where: { channel: 'whatsapp', phoneNumberId: config.whatsappPhoneNumberId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      console.log(`\n  WhatsApp delivery: ${readiness.isProven ? 'PROVEN' : `NOT PROVEN — missing ${readiness.missing.join(', ')}`}\n`);
      for (const p of proofs) {
        const state = p.deliveredAt ? `delivered ${p.deliveredAt.toISOString()}` : p.failureDetail ? `failed: ${p.failureDetail}` : p.acceptedAt ? 'accepted, waiting for the signed report' : 'not accepted';
        console.log(`  ${p.language}  ${p.destinationMasked}  ${state}`);
      }
      return;
    }

    const to = normalisePhone(arg('--to') ?? '');
    if (!to) throw new Error('Give the operator’s own WhatsApp number: --to +2223XXXXXXX');
    if (!isCloudChannel(config.whatsappChannel) || channel.name !== 'cloud-api') {
      throw new Error(`Nothing to prove: WHATSAPP_CHANNEL is "${config.whatsappChannel}". Configure cloud first (docs/64, docs/97).`);
    }
    const controls = sendControlsFrom(config);
    if (controls.mode !== 'test') {
      throw new Error('The delivery proof runs in test mode only (D181 §4): set WHATSAPP_MODE=test. Live sends are never needed to prove delivery.');
    }
    if (!controls.testRecipients.has(to)) {
      throw new Error(`${maskDestination(to)} is not in WHATSAPP_TEST_RECIPIENTS: the proof goes only to an allowlisted number.`);
    }

    console.log(`\n  Sending the delivery check to ${maskDestination(to)} in ${PROOF_LANGUAGES.join(', ')}\n`);
    for (const language of PROOF_LANGUAGES) {
      const reference = randomBytes(3).toString('hex').toUpperCase();
      const result = await channel.send({
        to,
        template: DELIVERY_CHECK_TEMPLATE.key,
        language,
        variables: { reference },
        idempotencyKey: `proof:${language}:${randomUUID()}`,
      });
      await prisma.messagingDeliveryProof.create({
        data: {
          id: newUuidV7Bin(),
          channel: 'whatsapp',
          provider: result.provider,
          template: DELIVERY_CHECK_TEMPLATE.key,
          language,
          destinationMasked: maskDestination(to),
          phoneNumberId: config.whatsappPhoneNumberId,
          providerMessageId: result.status === 'accepted' ? result.providerMessageId : null,
          acceptedAt: result.status === 'accepted' ? new Date() : null,
          failureDetail: result.status === 'failed' ? `${result.reason}: ${result.detail}`.slice(0, 200) : null,
        },
      });
      console.log(
        result.status === 'accepted'
          ? `  ${language}: accepted (reference ${reference}) — the proof completes when the signed delivery report arrives`
          : `  ${language}: NOT accepted — ${result.reason}: ${result.detail}`,
      );
    }
    console.log('\n  Check with: npm run whatsapp:prove -- --status\n');
  } finally {
    await app.close();
  }
}

main().catch((e: unknown) => {
  console.error(`\n  ${(e as Error).message}\n`);
  process.exitCode = 1;
});
