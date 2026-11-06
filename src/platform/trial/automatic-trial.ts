import { Prisma } from '@prisma/client';
import { actorRef } from '../../common/privacy/audit-contact';
import { binToUuid, newUuidV7Bin } from '../../common/utils/uuid.util';
import { lockSubscription } from '../../billing/renewal';
import type { PlatformAuditService } from '../platform-audit.service';
import { TRIAL_DURATION_DAYS, TRIAL_TERMS_VERSION, claimRequestHash, missingContacts, trialEndFor } from './trial-rules';
import { mayClaimNow, readFacts, readOwner } from './trial-facts';
import { startBranchTrialTx } from '../../entitlement/branch-entitlement.service';

/** How an automatic trial began: at the registration's completion, or at a legacy Owner's next sign-in. */
export type AutomaticTrialSource = 'registration' | 'sign_in';

export type AutomaticTrialOutcome =
  | { started: true; startedAt: Date; endsAt: Date }
  | { started: false; reason: 'already_started' | 'not_eligible' | 'not_owner' | 'contact_unverified' | 'contact_used_trial' };

/** The key that marks a claim as automatic — one per business, so a second start finds the first. */
export const automaticTrialKey = (companyId: Buffer): string => `auto:${companyId.toString('hex')}`;
export const isAutomaticTrialKey = (key: string | null | undefined): boolean => !!key && key.startsWith('auto:');

/** The trial-started notice's identity: one per business. */
export const TRIAL_STARTED_PERIOD = 'trial_start';
export const TRIAL_STARTED_THRESHOLD = 'start';

/**
 * Start the free trial automatically (0131; the owner's brief of 2026-11-06) — inside the caller's transaction, which
 * is the registration's completion or a legacy Owner's sign-in, so the trial, its record, its audit and its WhatsApp
 * notice commit together or not at all.
 *
 * The business must still be eligible exactly as a claim required it: an open eligibility (self-registration only — a
 * console-created business has none), nothing claimed or given, not closed, suspended or refused, the caller its Owner,
 * and every contact it registered with verified. A contact that already consumed a trial in another business never
 * starts a second one. The instant is read after the subscription's lock: 168 hours from now, never from the account's
 * creation. Idempotent: a business with a claim — automatic or claimed through an old link — is left as it is.
 *
 * The notice is created here and only queued: delivery happens after the commit, and the trial never waits for it.
 */
export async function startAutomaticTrialTx(
  tx: Prisma.TransactionClient,
  input: { companyId: Buffer; ownerUserId: Buffer; now: () => Date; source: AutomaticTrialSource; audit: Pick<PlatformAuditService, 'record'> },
): Promise<AutomaticTrialOutcome> {
  const { companyId, ownerUserId } = input;
  await lockSubscription(tx, companyId);
  const now = input.now();
  const row = await readFacts(tx, companyId);
  if (!row || !row.subscription) return { started: false, reason: 'not_eligible' };
  if (row.trialClaim) return { started: false, reason: 'already_started' };
  if (!mayClaimNow(row, now) || !row.trialEligibility) return { started: false, reason: 'not_eligible' };
  const status = row.subscription.status;
  if (status === 'suspended' || status === 'rejected') return { started: false, reason: 'not_eligible' };
  const owner = await readOwner(tx, { companyId, userId: ownerUserId });
  if (!owner) return { started: false, reason: 'not_owner' };
  if (missingContacts(row.trialEligibility.registrationMethod, owner).length > 0) return { started: false, reason: 'contact_unverified' };

  // A verified contact that already had a trial in another business never brings a second one.
  const contacts = [owner.phone, owner.email].filter((c): c is string => !!c);
  if (contacts.length) {
    const used = await tx.trialClaim.findFirst({
      where: {
        companyId: { not: companyId },
        company: { users: { some: { userBranches: { some: { role: { key: 'owner' } } }, OR: [...(owner.phone ? [{ phone: owner.phone }] : []), ...(owner.email ? [{ email: owner.email }] : [])] } } },
      },
      select: { id: true },
    });
    if (used) return { started: false, reason: 'contact_used_trial' };
  }

  const startedAt = now;
  const endsAt = trialEndFor(startedAt);
  const actor = input.source === 'registration' ? 'self-service' : actorRef(binToUuid(ownerUserId));
  const { version } = await tx.subscription.update({ where: { companyId }, data: { version: { increment: 1 } }, select: { version: true } });
  await tx.trialClaim.create({
    data: {
      id: newUuidV7Bin(),
      companyId,
      eligibilityId: row.trialEligibility.id,
      claimantUserId: ownerUserId,
      claimedAt: now,
      startedAt,
      endsAt,
      termsVersion: TRIAL_TERMS_VERSION,
      idempotencyKey: automaticTrialKey(companyId),
      requestHash: claimRequestHash(TRIAL_TERMS_VERSION),
      subscriptionVersionAfter: version,
      createdAt: now,
    },
  });
  // 0132: the trial belongs to the business's first store alone (docs/122 §1).
  await startBranchTrialTx(tx, { companyId, startedAt, endsAt, actor });
  await tx.subscriptionEvent.create({
    data: {
      id: newUuidV7Bin(),
      companyId,
      subscriptionId: row.subscription.id,
      kind: 'trial_claimed',
      note:
        input.source === 'registration'
          ? `Free trial started automatically when the registration completed: ${TRIAL_DURATION_DAYS} days. Nothing is charged.`
          : `Free trial started automatically at the Owner's first sign-in after automatic trials began: ${TRIAL_DURATION_DAYS} days. Nothing is charged.`,
      actor,
      createdAt: now,
    },
  });

  // The account-ready messages this trial replaces, waiting or failed: superseded, never sent again.
  const legacy = await tx.subscriptionNotice.updateMany({
    where: { companyId, kind: 'portal_instructions', state: { in: ['pending', 'failed'] } },
    data: { state: 'superseded', cancelReason: 'automatic_trial', completedAt: now, claimToken: null, claimedUntil: null },
  });

  const attempt = await tx.registrationAttempt.findFirst({ where: { companyId }, select: { language: true } });
  const language = attempt?.language === 'fr' || attempt?.language === 'ar' ? attempt.language : 'en';
  await tx.subscriptionNotice.create({
    data: {
      id: newUuidV7Bin(),
      companyId,
      subscriptionId: row.subscription.id,
      kind: 'trial_started',
      periodKey: TRIAL_STARTED_PERIOD,
      threshold: TRIAL_STARTED_THRESHOLD,
      dueAt: now,
      language,
      nextAttemptAt: now,
      createdAt: now,
    },
  });

  await input.audit.record(
    {
      admin: null,
      actor,
      action: 'trial.start_automatic',
      targetType: 'Company',
      targetId: companyId,
      targetLabel: row.name,
      after: {
        source: input.source,
        startedAt: startedAt.toISOString(),
        endsAt: endsAt.toISOString(),
        subscriptionVersion: version,
        legacyNoticesSuperseded: legacy.count,
      },
      at: now,
    },
    tx,
  );
  return { started: true, startedAt, endsAt };
}
