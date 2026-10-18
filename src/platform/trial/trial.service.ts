import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { actorRef } from '../../common/privacy/audit-contact';
import { binToUuid, newUuidV7Bin } from '../../common/utils/uuid.util';
import { CLOCK, type Clock } from '../../entitlement/clock';
import { EntitlementService } from '../../entitlement/entitlement.service';
import { stateOf, type EntitlementState } from '../../entitlement/entitlement-rules';
import { lockSubscription } from '../../billing/renewal';
import { PlatformAuditService } from '../platform-audit.service';
import {
  TRIAL_DURATION_DAYS,
  TRIAL_TERMS_VERSION,
  claimRequestHash,
  missingContacts,
  trialEndFor,
  trialOfferOf,
  trialViewOf,
  type OwnerContacts,
  type TrialFacts,
  type TrialOffer,
  type TrialRegistrationMethod,
  type TrialView,
} from './trial-rules';
import { isClosed, mayClaimNow, readFacts, readOwner, subscriptionRecordOf, type TrialFactsRow, type TrialPrincipal } from './trial-facts';
import { TrialRefusal } from './trial-refusal';
import { TrialSetupService } from './trial-setup.service';
import type { WebsiteSetup } from './trial-setup-rules';

/**
 * The portal-only seven-day free trial: the Owner's offer and the claim (0095, 0099; docs/76, docs/101 §5).
 *
 * **Portal-only is a product boundary, not a request check.** Only the Dukan ERP portal (dukan.tsxmr.com) shows this
 * workflow; the mobile app ships no claim code, route or words (its bundle audit proves it). Nothing here reads where
 * a request came from — an `Origin`, a `Referer`, a header saying "the portal" — because a client sets those to
 * whatever it likes, and a check a client can satisfy by lying protects nothing (the owner's correction of
 * 2026-10-13). What protects a claim is what a client cannot forge: the authenticated session of the business's
 * Owner, the contacts that Owner proved, the business's own eligibility re-read under the subscription row lock, the
 * idempotency key with its request hash, and the audit. No token is involved: the instructions carry the portal's
 * one address, the same for everyone (the owner's brief of 2026-10-18).
 *
 * **A claim is a fact, never a payment.** It writes one immutable `trial_claims` row (168 hours from the server's
 * instant, taken under the lock), bumps `subscriptions.version` and nothing else on it, and records the event and the
 * audit. No payment, billing period, seat, renewal, status or period end — a trial that ends leaves the business
 * read-only, exactly as it was before, plus seven days of history.
 */

export interface ClaimInput {
  /** The website's key for one attempt, kept for that attempt's retries. */
  idempotencyKey: string;
  /** The terms version the portal showed. */
  termsVersion: string;
}

/** The website's trial card (GET platform/my-subscription/trial). */
export interface TrialStatus {
  state: EntitlementState;
  trial: TrialView | null;
  offer: TrialOffer | null;
  /**
   * Where the setup instructions stand, with their history and when the Owner may ask again — while the business may
   * claim (`trial_available`), else null; null too when it cannot be read right now. Never a condition for claiming:
   * the offer does not read it, and is answered whether or not it could be read.
   */
  setup: WebsiteSetup | null;
  calculatedAt: string;
}

/** A claim's answer: 201 the first time; 200 and `replayed` for a retry of the same attempt. */
export interface ClaimAnswer {
  claimed: true;
  replayed: boolean;
  /** The state now — `trial_active` for the claim, and for any retry while the trial runs. */
  state: EntitlementState;
  trial: TrialView;
  subscriptionVersion: number;
}

@Injectable()
export class TrialService {
  private readonly logger = new Logger(TrialService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlement: EntitlementService,
    private readonly audit: PlatformAuditService,
    private readonly setup: TrialSetupService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ── The rules, over one reading ──────────────────────────────────────────

  /** The card: the state, the trial's view, and the offer — all from the one reading given. */
  private statusOf(companyId: Buffer, row: TrialFactsRow, owner: OwnerContacts, now: Date): Omit<TrialStatus, 'setup'> {
    const record = subscriptionRecordOf(row);
    const state = stateOf(record, now);
    const zone = this.entitlement.trialZone(companyId, row.timezone);
    return {
      state,
      trial: trialViewOf(record.trial, state, now, zone, record),
      offer: trialOfferOf(
        { eligibility: row.trialEligibility, claimed: row.trialClaim !== null, closed: isClosed(row), state, owner },
        now,
        zone,
      ),
      calculatedAt: now.toISOString(),
    };
  }

  // ── The website's reads ──────────────────────────────────────────────────

  /**
   * The Owner's trial card. Readable in every state — a business that has not started is exactly who reads it — and
   * by the Owner alone (403 `owner_only` for everyone else, before anything is read about the trial). While the
   * business may claim, it also says where the setup instructions stand: the offer beside it is the same either way.
   */
  async status(who: TrialPrincipal): Promise<TrialStatus> {
    const now = this.clock.now();
    const owner = await readOwner(this.prisma, who);
    const row = owner ? await readFacts(this.prisma, who.companyId) : null;
    if (!owner || !row) throw new TrialRefusal('owner_only');
    const card = this.statusOf(who.companyId, row, owner, now);
    const eligibility = row.trialEligibility;
    return {
      state: card.state,
      trial: card.trial,
      offer: card.offer,
      setup: eligibility && mayClaimNow(row, now) ? await this.setupOf(who, owner, eligibility.registrationMethod, now) : null,
      calculatedAt: card.calculatedAt,
    };
  }

  /**
   * Where the setup instructions stand — or null when that cannot be read now, which is logged (C3; review finding
   * R2-4). The card never fails with it: the state, the trial and the offer are answered either way, and the Owner can
   * still start the trial from it.
   */
  private async setupOf(who: TrialPrincipal, owner: OwnerContacts, method: TrialRegistrationMethod, now: Date): Promise<WebsiteSetup | null> {
    try {
      return await this.setup.websiteSetup(who, owner, method, now);
    } catch (e) {
      this.logger.warn(`Free trial setup status not read for company ${binToUuid(who.companyId)}: ${(e as Error).message}`);
      return null;
    }
  }

  // ── The claim ────────────────────────────────────────────────────────────

  /**
   * Start the free trial, on the Owner's explicit confirmation — one transaction:
   *
   *  1. the subscription row is locked, and the instant is read AFTER the lock: the trial starts when the claim is
   *     made, never when the account was created and never at a moment the client names;
   *  2. the Owner role is checked first, so a Manager or an Employee learns nothing about the trial's state;
   *  3. a claim that exists answers this one: the same key and request replay it, the same key with another request
   *     is a conflict, another key is told the trial was already used — also after it ended;
   *  4. everything else is re-read under the lock, in the order the refusals are listed: closed, suspended, refused,
   *     not available (no eligibility, eligibility closed, or any access already given), terms changed, and a required
   *     contact unverified;
   *  5. the version is bumped, the claim inserted with the version it left, and the event and the audit written — the
   *     audit last.
   *
   * Two claims serialise on the lock and the loser reads the winner's row (step 3). The unique company index is the
   * backstop: a claim that still collides re-reads the winner and answers as step 3 would.
   *
   * Refusals are audited outside the rolled-back transaction, with the code (and which contacts are missing) — never
   * a contact or a code.
   */
  async claim(who: TrialPrincipal, input: ClaimInput): Promise<ClaimAnswer> {
    const requestHash = claimRequestHash(input.termsVersion);
    const seen: { label: string | null; at: Date | null } = { label: null, at: null };
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockSubscription(tx, who.companyId);
        const now = this.clock.now();
        seen.at = now;
        const owner = await readOwner(tx, who);
        const row = await readFacts(tx, who.companyId);
        seen.label = row?.name ?? null;
        if (!owner || !row) throw new TrialRefusal('owner_only');
        if (row.trialClaim) return this.answerToExisting(who.companyId, row, owner, input, requestHash, now);
        const { subscriptionId, eligibilityId } = this.claimable(row, owner, input, now);
        return this.start(tx, who, row, { subscriptionId, eligibilityId }, input, requestHash, now);
      });
    } catch (e) {
      if (e instanceof TrialRefusal) {
        await this.auditRefusal(who, seen.label, e, seen.at);
        throw e;
      }
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return this.afterLostRace(who, input, requestHash, e);
      }
      throw e;
    }
  }

  /** Step 3: a claim exists. The same attempt is replayed with what it recorded; anything else is refused. */
  private answerToExisting(
    companyId: Buffer,
    row: TrialFactsRow,
    owner: OwnerContacts,
    input: ClaimInput,
    requestHash: string,
    now: Date,
  ): ClaimAnswer {
    const claim = row.trialClaim!;
    const card = this.statusOf(companyId, row, owner, now);
    if (claim.idempotencyKey !== input.idempotencyKey) throw new TrialRefusal('trial_already_claimed', { trial: card.trial });
    if (claim.requestHash !== requestHash) throw new TrialRefusal('idempotency_conflict');
    return { claimed: true, replayed: true, state: card.state, trial: card.trial!, subscriptionVersion: claim.subscriptionVersionAfter };
  }

  /** Step 4, in order. Returns what the claim attaches to; throws the first refusal that applies. */
  private claimable(
    row: TrialFactsRow,
    owner: OwnerContacts,
    input: ClaimInput,
    now: Date,
  ): { subscriptionId: Buffer; eligibilityId: Buffer } {
    const status = row.subscription?.status;
    if (isClosed(row)) throw new TrialRefusal('business_closed');
    if (status === 'suspended') throw new TrialRefusal('business_suspended');
    if (status === 'rejected') throw new TrialRefusal('business_refused');
    const eligibility = row.trialEligibility;
    if (!row.subscription || !eligibility || stateOf(subscriptionRecordOf(row), now) !== 'trial_available') {
      throw new TrialRefusal('trial_not_available');
    }
    if (input.termsVersion !== TRIAL_TERMS_VERSION) {
      throw new TrialRefusal('terms_changed', { termsVersion: TRIAL_TERMS_VERSION });
    }
    const missing = missingContacts(eligibility.registrationMethod, owner);
    if (missing.length > 0) throw new TrialRefusal('contact_unverified', { missingContacts: missing });
    return { subscriptionId: row.subscription.id, eligibilityId: eligibility.id };
  }

  /** Step 5: the writes, in lock order — the subscription it already holds, the trial's rows, the event, the audit. */
  private async start(
    tx: Prisma.TransactionClient,
    who: TrialPrincipal,
    row: TrialFactsRow,
    refs: { subscriptionId: Buffer; eligibilityId: Buffer },
    input: ClaimInput,
    requestHash: string,
    now: Date,
  ): Promise<ClaimAnswer> {
    const startedAt = now;
    // From the same instant, as the CHECK compares it: exactly 168 hours, never "seven days" of some calendar.
    const endsAt = trialEndFor(startedAt);
    const actor = actorRef(binToUuid(who.userId));

    // The version first: the claim stores the version it left, and a claim is never edited afterwards. Nothing else
    // on the subscription moves — not its status, its period or its grant.
    const { version } = await tx.subscription.update({
      where: { companyId: who.companyId },
      data: { version: { increment: 1 } },
      select: { version: true },
    });

    await tx.trialClaim.create({
      data: {
        id: newUuidV7Bin(),
        companyId: who.companyId,
        eligibilityId: refs.eligibilityId,
        claimantUserId: who.userId,
        claimedAt: now,
        startedAt,
        endsAt,
        termsVersion: input.termsVersion,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        subscriptionVersionAfter: version,
        createdAt: now,
      },
    });

    await tx.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId: who.companyId,
        subscriptionId: refs.subscriptionId,
        kind: 'trial_claimed',
        // No instant in the note (C7): the start and the end travel as data — the claim's own columns, the trial's
        // view — and every client shows them in the business's zone. A note is English text printed as it is.
        note: `Free trial claimed on the Dukan ERP portal by the Owner: ${TRIAL_DURATION_DAYS} days from the claim. Nothing was charged.`,
        actor,
        createdAt: now,
      },
    });

    await this.audit.record(
      {
        admin: null,
        actor,
        action: 'trial.claim',
        targetType: 'Company',
        targetId: who.companyId,
        targetLabel: row.name,
        after: {
          claimedAt: now.toISOString(),
          startedAt: startedAt.toISOString(),
          endsAt: endsAt.toISOString(),
          termsVersion: input.termsVersion,
          subscriptionVersion: version,
        },
        at: now,
      },
      tx,
    );

    const trial: TrialFacts = { eligible: true, claim: { claimedAt: now, startedAt, endsAt } };
    const record = { ...subscriptionRecordOf(row), trial };
    const state = stateOf(record, now);
    // Nothing follows a trial claimed this instant: a claim needs an open eligibility, so no access was ever given.
    const view = trialViewOf(trial, state, now, this.entitlement.trialZone(who.companyId, row.timezone), record)!;
    return { claimed: true, replayed: false, state, trial: view, subscriptionVersion: version };
  }

  /**
   * The unique company index refused a second claim that read none — the backstop behind the lock. The winner is
   * re-read, and this request is answered exactly as step 3 answers it: a replay of the same attempt, or a refusal.
   */
  private async afterLostRace(
    who: TrialPrincipal,
    input: ClaimInput,
    requestHash: string,
    collision: Prisma.PrismaClientKnownRequestError,
  ): Promise<ClaimAnswer> {
    const now = this.clock.now();
    const owner = await readOwner(this.prisma, who);
    const row = await readFacts(this.prisma, who.companyId);
    if (!owner || !row?.trialClaim) throw collision;
    try {
      return this.answerToExisting(who.companyId, row, owner, input, requestHash, now);
    } catch (e) {
      if (e instanceof TrialRefusal) await this.auditRefusal(who, row.name, e, now);
      throw e;
    }
  }

  /**
   * A refused claim, written down outside the transaction that refused it: the code, and which contacts were
   * missing — never a contact, a token or a code. A failure to write it is logged and never replaces the refusal.
   */
  private async auditRefusal(who: TrialPrincipal, label: string | null, refusal: TrialRefusal, at: Date | null): Promise<void> {
    try {
      await this.audit.record({
        admin: null,
        actor: actorRef(binToUuid(who.userId)),
        action: 'trial.claim_refused',
        targetType: 'Company',
        targetId: who.companyId,
        targetLabel: label,
        after: {
          reason: refusal.code,
          ...(refusal.details.missingContacts ? { missingContacts: refusal.details.missingContacts } : {}),
        },
        at: at ?? undefined,
      });
    } catch (e) {
      this.logger.warn(`Free trial refusal not audited for company ${binToUuid(who.companyId)}: ${(e as Error).message}`);
    }
  }
}
