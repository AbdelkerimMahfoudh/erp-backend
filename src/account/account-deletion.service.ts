import { HttpException, HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  AccountDeletionKind,
  AccountDeletionStatus,
  OtpDeliveryState,
  OtpStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { HashingService } from '../common/security/hashing.service';
import { OtpService, RequestOutcome } from '../auth/otp/otp.service';
import { maskPhone } from '../auth/otp/otp-code.util';
import { WHATSAPP_CHANNEL, WhatsAppChannel } from '../messaging/whatsapp-channel';
import { ACCOUNT_DELETED_TEMPLATE, MessageLanguage } from '../messaging/templates';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { generatePersonalId } from '../auth/identifier';
import { STORAGE_PROVIDER, type StorageProvider } from '../storage/storage.types';
import { lockSubscription } from '../billing/renewal';
import {
  DELETED_USER_NAME,
  UNUSABLE_PASSWORD_HASH,
  deidentifiedLogin,
  deletionKindFor,
  isOpen,
  proofProblem,
  requestIsFresh,
} from './deletion-rules';

/**
 * Account deletion, confirmed by a WhatsApp code (docs/64).
 *
 * The rule the whole file enforces: **nothing is deleted unless a single-use
 * deletion code was sent to the account's verified WhatsApp number and typed
 * back by the account holder.** There is no other path. The executor
 * (`execute`) re-reads the request and its challenge inside the transaction
 * and refuses unless the challenge is a verified `account_deletion` challenge
 * for the same person, so an administrator tool, a background job or a hand
 * edit of the status column cannot reach the de-identification without the
 * code.
 *
 * What "deleted" means here: the person's identity and contact details are
 * removed wherever the app copied them — sessions, devices, codes, sign-up
 * records, seat requests, the counter's records — and every credential is
 * revoked; the financial records they appear on — sales, purchases, closings,
 * ledgers, the audit trail — are kept, as the law requires for accounting, and
 * keep pointing at a row that now says "Deleted user". The request stores
 * counts of what was kept, never a name, a number or an amount.
 *
 * What is NOT removed, said as such (`NOT_REMOVED`, docs/24): the hash-chained
 * audit trail, subscription and platform audit events (append-only; editing
 * them would break the chain), the names on append-only money-agent records
 * (positions, rebalancings, configuration versions), and backups — which
 * expire on their own schedule, never edited, and which TSX-MR has not yet
 * fixed (production stays blocked until it does).
 */

/** What a code's destination reads once its person is deleted: the row stays, the number does not. */
export const REDACTED_DESTINATION = '[deleted]';
/** What replaces a request fingerprint that hashed a deleted number: a value no request can produce. */
export const REDACTED_REQUEST_HASH = '0'.repeat(64);

/** The copies a deletion cannot reach, named in its summary rather than claimed gone. */
export const NOT_REMOVED = ['audit_logs', 'subscription_events', 'platform_audit_events', 'agent_append_only_snapshots', 'backups'] as const;

export interface DeletionPrincipal {
  userId: Buffer;
  companyId: Buffer;
  sessionId: Buffer;
}

export interface DeletionRequestView {
  id: string;
  kind: AccountDeletionKind;
  status: AccountDeletionStatus;
  destinationMasked: string;
  language: string;
  createdAt: string;
  codeSentAt: string | null;
  codeExpiresAt: string | null;
  attemptsRemaining: number | null;
  resendAvailableAt: string | null;
  /** True only when the channel accepted the message. Never assumed. */
  delivered: boolean;
  /** The delivery failure class, when the code did not go out. */
  deliveryProblem: string | null;
  confirmedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  failure: string | null;
  retained: Prisma.JsonValue | null;
}

type RequestRow = Prisma.AccountDeletionRequestGetPayload<Record<string, never>>;
type ChallengeRow = Prisma.OtpChallengeGetPayload<Record<string, never>>;

/** Thrown inside the executor when the proof does not hold. Named so a test can tell it from a crash. */
export class DeletionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeletionRefused';
  }
}

function refuse(status: HttpStatus, code: string, message: string, extra: Record<string, unknown> = {}): HttpException {
  return new HttpException({ code, message, ...extra }, status);
}

/** The localised phrase for what was deleted, in the completion message. */
const DELETED_WHAT: Record<MessageLanguage, Record<AccountDeletionKind, string>> = {
  en: { personal_login: 'your login', company_closure: 'your business and every login in it' },
  fr: { personal_login: 'votre identifiant', company_closure: 'votre commerce et tous ses identifiants' },
  ar: { personal_login: 'حساب الدخول الخاص بك', company_closure: 'متجرك وجميع حسابات الدخول فيه' },
};

@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly otp: OtpService,
    @Inject(WHATSAPP_CHANNEL) private readonly channel: WhatsAppChannel,
    @Optional() @Inject(STORAGE_PROVIDER) private readonly storage?: StorageProvider,
  ) {}

  // ------------------------------------------------------------------ reads

  /** The person's latest request, whatever its state, or null. */
  async current(p: DeletionPrincipal): Promise<DeletionRequestView | null> {
    const latest = await this.latestRequest(p);
    return latest ? this.view(latest) : null;
  }

  /**
   * What this person's deletion would delete. Decided from the role table:
   * the last active Owner closes the business, everybody else deletes a login.
   */
  async kindFor(companyId: Buffer, userId: Buffer): Promise<AccountDeletionKind> {
    const ownerRole = await this.prisma.role.findFirst({ where: { companyId, key: 'owner' }, select: { id: true } });
    if (!ownerRole) return 'personal_login';

    const mine = await this.prisma.userBranch.findFirst({
      where: { companyId, userId, roleId: ownerRole.id },
      select: { id: true },
    });
    if (!mine) return 'personal_login';

    const others = await this.prisma.userBranch.findMany({
      where: { companyId, roleId: ownerRole.id, userId: { not: userId } },
      select: { userId: true },
    });
    const ids = [...new Map(others.map((o) => [o.userId.toString('hex'), o.userId])).values()];
    const active =
      ids.length === 0 ? 0 : await this.prisma.user.count({ where: { id: { in: ids }, isActive: true, deletedAt: null } });
    return deletionKindFor({ holdsOwnerRole: true, otherActiveOwners: active });
  }

  // ----------------------------------------------------------------- start

  /**
   * Ask to delete: the password again, then a code to the verified number.
   *
   * Refuses, in order: a wrong password (generic, timing-even), a server that
   * cannot send codes at all — before the number, so a login without one is not
   * sent to verify a number that could not be verified either — and a login
   * with no verified WhatsApp number (the only channel; nothing is
   * substituted). Nothing is created by a refusal. A request that is already
   * open is returned as it is rather than replaced, so a double tap sends one
   * code.
   */
  async start(
    p: DeletionPrincipal,
    input: { password: string; clientUuid?: string; language?: MessageLanguage; ip?: string },
  ): Promise<DeletionRequestView> {
    const now = new Date();
    const user = await this.reauthenticate(p, input.password);

    if (!this.otp.canDeliver) {
      throw refuse(
        HttpStatus.SERVICE_UNAVAILABLE,
        'deletion_unavailable',
        'Deletion codes cannot be sent by this server right now. Nothing was changed.',
      );
    }
    if (!user.phone || !user.phoneVerifiedAt) {
      throw refuse(
        HttpStatus.CONFLICT,
        'whatsapp_number_required',
        'Add and verify your WhatsApp number first. The deletion code is sent only there.',
      );
    }

    const open = await this.openRequest(p);
    if (open) {
      if (requestIsFresh(open.reauthenticatedAt, now)) return this.view(open);
      await this.markFailed(open.id, 'request_expired');
    }

    if (input.clientUuid) {
      const same = await this.prisma.accountDeletionRequest.findFirst({
        where: { companyId: p.companyId, userId: p.userId, clientUuid: uuidToBin(input.clientUuid) },
      });
      if (same) return this.view(same);
    }

    const kind = await this.kindFor(p.companyId, p.userId);
    const id = newUuidV7Bin();
    const language = input.language ?? 'en';
    let created: RequestRow;
    try {
      created = await this.prisma.accountDeletionRequest.create({
        data: {
          id,
          companyId: p.companyId,
          userId: p.userId,
          kind,
          status: 'awaiting_code',
          destinationMasked: maskPhone(user.phone),
          language,
          activeKey: p.userId,
          clientUuid: input.clientUuid ? uuidToBin(input.clientUuid) : null,
          requestIp: input.ip?.slice(0, 45) ?? null,
          reauthenticatedAt: now,
        },
      });
    } catch (e) {
      // Two taps racing on the UNIQUE active key: the loser returns the winner.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const again = await this.openRequest(p);
        if (again) return this.view(again);
      }
      throw e;
    }

    await this.audit(p, id, 'create', { kind, destination: created.destinationMasked }, 'Account deletion requested');
    return this.send(created, user.phone, language, `deletion:${binToUuid(id)}`);
  }

  // ---------------------------------------------------------------- resend

  async resend(p: DeletionPrincipal, language?: MessageLanguage): Promise<DeletionRequestView> {
    const now = new Date();
    const open = await this.requireAwaiting(p);
    if (!requestIsFresh(open.reauthenticatedAt, now)) {
      await this.markFailed(open.id, 'request_expired');
      throw refuse(HttpStatus.GONE, 'request_expired', 'This request has expired. Start again with your password.');
    }
    const user = await this.loadUser(p);
    if (!user?.phone || !user.phoneVerifiedAt) {
      await this.markFailed(open.id, 'number_changed');
      throw refuse(HttpStatus.CONFLICT, 'number_changed', 'Your WhatsApp number changed. Verify it and start again.');
    }
    if (!this.otp.canDeliver) {
      throw refuse(HttpStatus.SERVICE_UNAVAILABLE, 'deletion_unavailable', 'Deletion codes cannot be sent right now.');
    }

    const lang = language ?? (open.language as MessageLanguage);
    let outcome: RequestOutcome | null = null;
    if (open.challengeId) {
      outcome = await this.otp.resend({ companyId: p.companyId, userId: p.userId, challengeId: open.challengeId, language: lang });
      if (!outcome.ok && outcome.reason === 'rate_limited') {
        const challenge = await this.challengeOf(open);
        throw refuse(HttpStatus.TOO_MANY_REQUESTS, 'too_many_codes', outcome.detail, {
          resendAvailableAt: challenge?.resendNotBefore?.toISOString() ?? null,
        });
      }
      // "No challenge to resend": the old one expired or locked. A fresh one, then.
      if (!outcome.ok) outcome = null;
    }
    if (!outcome) {
      outcome = await this.otp.request({
        companyId: p.companyId,
        userId: p.userId,
        purpose: 'account_deletion',
        destination: user.phone,
        language: lang,
      });
    }
    return this.applyOutcome(open, outcome, lang);
  }

  // --------------------------------------------------------------- confirm

  /**
   * The code, and then the deletion.
   *
   * Idempotent for a retry after a lost response: a request that is already
   * completed is answered with its final state, and one that another
   * confirmation is executing is answered with its current state. The winning
   * transition is a conditional update on `awaiting_code` + `version`, so two
   * confirmations of the same code produce exactly one deletion.
   */
  async confirm(p: DeletionPrincipal, code: string): Promise<DeletionRequestView> {
    const now = new Date();
    const latest = await this.latestRequest(p);
    if (!latest) throw refuse(HttpStatus.NOT_FOUND, 'no_open_request', 'There is no deletion request to confirm.');
    if (latest.status === 'completed' || latest.status === 'confirmed' || latest.status === 'processing') {
      return this.view(latest);
    }
    if (latest.status !== 'awaiting_code') {
      throw refuse(HttpStatus.NOT_FOUND, 'no_open_request', 'There is no deletion request to confirm. Start again.');
    }
    if (!requestIsFresh(latest.reauthenticatedAt, now)) {
      await this.markFailed(latest.id, 'request_expired');
      throw refuse(HttpStatus.GONE, 'request_expired', 'This request has expired. Start again with your password.');
    }
    if (!latest.challengeId) {
      throw refuse(HttpStatus.CONFLICT, 'code_not_active', 'No code is active for this request. Ask for a new one.');
    }

    // The number the code went to must still be this person's verified number.
    const user = await this.loadUser(p);
    const challenge = await this.challengeOf(latest);
    if (!user?.phone || !user.phoneVerifiedAt || !challenge || challenge.destination !== user.phone) {
      await this.markFailed(latest.id, 'number_changed');
      throw refuse(HttpStatus.CONFLICT, 'number_changed', 'Your WhatsApp number changed. Verify it and start again.');
    }

    const verdict = await this.otp.verify({ companyId: p.companyId, userId: p.userId, challengeId: latest.challengeId, code });
    if (!verdict.ok) {
      switch (verdict.reason) {
        case 'invalid_code':
          throw refuse(HttpStatus.BAD_REQUEST, 'invalid_code', 'That code is not right.', {
            attemptsRemaining: verdict.attemptsRemaining,
          });
        case 'expired':
          throw refuse(HttpStatus.GONE, 'code_expired', 'That code has expired. Ask for a new one.');
        case 'locked':
          await this.markFailed(latest.id, 'too_many_attempts');
          throw refuse(HttpStatus.CONFLICT, 'too_many_attempts', 'Too many wrong codes. Start again with your password.');
        case 'already_used': {
          // The code was spent by another confirmation of this same request —
          // a retry after a lost response, or two taps racing. That deletion
          // is done or in flight; answer with the request as it stands and let
          // the client read the final state.
          const again = await this.latestRequest(p);
          return this.view(again ?? latest);
        }
        default:
          throw refuse(HttpStatus.CONFLICT, 'code_not_active', 'No code is active for this request. Ask for a new one.');
      }
    }
    if (verdict.purpose !== 'account_deletion') {
      // Cannot happen by construction — the request's challenge was issued for
      // this purpose — and is refused anyway, because "cannot happen" is not a control.
      await this.markFailed(latest.id, 'wrong_purpose');
      throw refuse(HttpStatus.CONFLICT, 'code_not_active', 'That code is not an account-deletion code.');
    }

    const { count } = await this.prisma.accountDeletionRequest.updateMany({
      where: { id: latest.id, status: 'awaiting_code', version: latest.version },
      data: { status: 'confirmed', confirmedAt: now, version: { increment: 1 } },
    });
    if (count === 0) {
      const again = await this.latestRequest(p);
      return this.view(again ?? latest);
    }
    return this.execute(latest.id);
  }

  // ---------------------------------------------------------------- cancel

  async cancel(p: DeletionPrincipal): Promise<DeletionRequestView | null> {
    const now = new Date();
    const open = await this.openRequest(p);
    if (!open) {
      const latest = await this.latestRequest(p);
      return latest ? this.view(latest) : null;
    }
    if (open.status !== 'awaiting_code') return this.view(open);

    const { count } = await this.prisma.accountDeletionRequest.updateMany({
      where: { id: open.id, status: 'awaiting_code' },
      data: { status: 'cancelled', cancelledAt: now, activeKey: null, version: { increment: 1 } },
    });
    if (count > 0) {
      if (open.challengeId) await this.otp.cancel(open.challengeId);
      await this.audit(p, open.id, 'status_change', { status: 'cancelled' }, 'Account deletion request cancelled by its owner');
    }
    const fresh = await this.prisma.accountDeletionRequest.findUnique({ where: { id: open.id } });
    return this.view(fresh ?? open);
  }

  // -------------------------------------------------------------- executor

  /**
   * Delete, exactly once, and only against proof.
   *
   * Everything happens in one transaction: the proof is re-read inside it, the
   * request is moved to `processing` by a conditional update, the
   * de-identification runs, and the request is completed with a summary of
   * what was kept. Any failure rolls the whole thing back and marks the
   * request `failed` — the account is intact and the person is told so.
   */
  async execute(requestId: Buffer): Promise<DeletionRequestView> {
    const now = new Date();
    let done: { request: RequestRow; destination: string; receiptKeys: string[] } | null = null;

    try {
      done = await this.prisma.$transaction(
        async (tx) => {
          const request = await tx.accountDeletionRequest.findUnique({ where: { id: requestId } });
          if (!request) throw new DeletionRefused('request not found');
          const challenge = request.challengeId
            ? await tx.otpChallenge.findUnique({ where: { id: request.challengeId } })
            : null;
          const problem = proofProblem(request, challenge, now);
          if (problem) throw new DeletionRefused(problem);

          const moved = await tx.accountDeletionRequest.updateMany({
            where: { id: requestId, status: 'confirmed' },
            data: { status: 'processing', processingStartedAt: now, version: { increment: 1 } },
          });
          if (moved.count === 0) throw new DeletionRefused('request is no longer confirmed');

          const { summary, receiptKeys } =
            request.kind === 'company_closure'
              ? await this.closeCompany(tx, request, now)
              : { summary: await this.deleteLogin(tx, request.companyId, request.userId, now), receiptKeys: [] as string[] };

          await tx.accountDeletionRequest.update({
            where: { id: requestId },
            data: {
              status: 'completed',
              completedAt: new Date(),
              activeKey: null,
              // The address the request came from goes with the person (review F07); the request itself stays, as proof.
              requestIp: null,
              retainedSummary: summary as Prisma.InputJsonValue,
              version: { increment: 1 },
            },
          });
          await tx.auditLog.create({
            data: {
              companyId: request.companyId,
              userId: request.userId,
              entityType: 'AccountDeletionRequest',
              entityId: requestId,
              action: 'delete',
              after: { kind: request.kind, ...summary } as Prisma.InputJsonValue,
              reason:
                request.kind === 'company_closure'
                  ? 'Business closed by its Owner after WhatsApp code confirmation'
                  : 'Login deleted by its holder after WhatsApp code confirmation',
            },
          });
          return { request, destination: challenge!.destination, receiptKeys };
        },
        { timeout: 60_000, maxWait: 10_000 },
      );
    } catch (e) {
      const detail = e instanceof DeletionRefused ? e.message : 'The deletion could not be completed; nothing was changed';
      await this.prisma.accountDeletionRequest.updateMany({
        where: { id: requestId, status: { in: ['confirmed', 'processing'] } },
        data: { status: 'failed', failureDetail: detail.slice(0, 200), activeKey: null, version: { increment: 1 } },
      });
      this.logger.error(`Account deletion ${binToUuid(requestId)} refused or failed: ${detail}`);
      throw refuse(
        HttpStatus.SERVICE_UNAVAILABLE,
        'deletion_failed',
        'Your account could not be deleted right now. Nothing was changed — please try again.',
      );
    }

    await this.removeFiles(done.receiptKeys, requestId);
    await this.notifyDeleted(done.destination, done.request.language as MessageLanguage, done.request.kind, requestId);
    const fresh = await this.prisma.accountDeletionRequest.findUnique({ where: { id: requestId } });
    return this.toView(fresh ?? done.request, null);
  }

  /** One login: identity and contacts gone wherever they were copied, every credential revoked, records kept. */
  private async deleteLogin(
    tx: Prisma.TransactionClient,
    companyId: Buffer,
    userId: Buffer,
    now: Date,
  ): Promise<Record<string, unknown>> {
    const people = await tx.user.findMany({ where: { id: userId, companyId }, select: { id: true, email: true, phone: true } });
    const forgotten = await this.forgetPeople(tx, companyId, people, now, userId);
    await tx.notification.deleteMany({ where: { companyId, targetUserId: userId } });
    // The portal instructions this person asked for (0099): nothing more goes out for them, and no destination is kept.
    await tx.subscriptionNotice.updateMany({
      where: { companyId, requestedByUserId: userId, state: { in: ['pending', 'sending'] } },
      data: { state: 'cancelled', cancelReason: 'deleted', claimToken: null, claimedUntil: null, completedAt: now },
    });
    await tx.subscriptionNotice.updateMany({ where: { companyId, requestedByUserId: userId }, data: { destinationMasked: null, destinationHash: null } });

    const [ledgerEntries, auditRows] = await Promise.all([
      tx.employeeDebtEntry.count({ where: { companyId, userId } }),
      tx.auditLog.count({ where: { companyId, userId } }),
    ]);
    return {
      kind: 'personal_login',
      loginsDeleted: 1,
      ...forgotten,
      retained: { ledgerEntries, auditRows },
      notRemoved: NOT_REMOVED,
    };
  }

  /**
   * The business: every login as above; the contacts of its customers, suppliers and the people it lent to or
   * employed; the numbers its counter served; its notes, receipts, branch addresses and city; the company closed.
   * The receipt files are returned, to be removed from storage once the transaction has committed.
   */
  private async closeCompany(
    tx: Prisma.TransactionClient,
    request: RequestRow,
    now: Date,
  ): Promise<{ summary: Record<string, unknown>; receiptKeys: string[] }> {
    const companyId = request.companyId;
    // The subscription first, as every writer that touches it takes it (billing/renewal.ts): a free trial claimed at
    // this very moment (0095) waits for the closure and then finds the business closed — rather than deadlocking with
    // it over the rows this transaction is about to change.
    await lockSubscription(tx, companyId);
    const people = await tx.user.findMany({ where: { companyId, deletedAt: null }, select: { id: true, email: true, phone: true } });
    const forgotten = await this.forgetPeople(tx, companyId, people, now, request.userId);
    // People already removed before the closure — a cancelled invitation keeps its name — are forgotten too (review F11).
    await tx.user.updateMany({ where: { companyId, deletedAt: { not: null } }, data: { name: DELETED_USER_NAME, email: null, phone: null } });
    await tx.notification.deleteMany({ where: { companyId } });
    await tx.outboxChange.deleteMany({ where: { companyId } });
    // Every challenge and session of the company, whoever's — a login deleted earlier included.
    await tx.otpChallenge.updateMany({ where: { companyId }, data: { destination: REDACTED_DESTINATION, candidatePhone: null } });
    await tx.authSession.updateMany({ where: { companyId }, data: { ip: null, userAgent: null, deviceName: null, deviceId: null } });
    await tx.userDevice.updateMany({ where: { companyId }, data: { label: null, model: null } });

    const customers = await tx.customer.updateMany({ where: { companyId }, data: { name: null, phone: null, notes: null } });
    const suppliers = await tx.supplier.updateMany({ where: { companyId }, data: { phone: null, notes: null } });
    // The people it lent to or employed are people; another store is a business, whose name stays.
    const persons = await tx.counterparty.updateMany({
      where: { companyId, kind: { in: ['manual_person', 'employee'] } },
      data: { name: DELETED_USER_NAME, phone: null, city: null, note: null },
    });
    await tx.counterparty.updateMany({ where: { companyId, kind: { in: ['manual_store', 'connected_store'] } }, data: { phone: null, note: null } });
    // The numbers payments came from are people's contact details too (D151); the money itself stays.
    // Each payment's request fingerprint hashed the number with the rest of the row: left, it would give the number back
    // to anyone who tried every 8-digit one (review F03). A closed business sends no more requests to compare it with.
    await tx.payment.updateMany({ where: { companyId }, data: { payerNumber: null, clientRequestHash: null } });
    // The numbers the money services counter served: blanked, the amounts and legs kept (the 0092 trigger allows exactly
    // this, and does not guard the fingerprint) — and the fingerprint that hashed the number replaced, for the same reason.
    const agentNumbers = await tx.agentTransaction.updateMany({
      where: { companyId },
      data: { customerNumber: '', customerNumberLast4: '', clientRequestHash: REDACTED_REQUEST_HASH },
    });
    await tx.agentMistakeReport.updateMany({ where: { companyId }, data: { note: null, decisionNote: null } });
    // Free text and receipts: written by people, about people.
    const receipts = await tx.expense.findMany({ where: { companyId, receiptKey: { not: null } }, select: { receiptKey: true } });
    await tx.expense.updateMany({ where: { companyId }, data: { note: null, receiptKey: null } });
    await tx.branch.updateMany({ where: { companyId }, data: { isActive: false, phone: null, address: null } });
    await tx.registrationAttempt.updateMany({
      where: { companyId },
      data: { ownerName: DELETED_USER_NAME, email: null, phone: null, city: null },
    });

    const sub = await tx.subscription.findFirst({ where: { companyId } });
    if (sub && sub.status !== 'cancelled') {
      await tx.subscription.update({ where: { id: sub.id }, data: { status: 'cancelled', version: { increment: 1 } } });
      await tx.subscriptionEvent.create({
        data: {
          id: newUuidV7Bin(),
          companyId,
          subscriptionId: sub.id,
          kind: 'cancelled',
          note: 'Business closed by its Owner (account deletion)',
          periodEndAfter: sub.currentPeriodEnd,
          branchesAfter: sub.subscribedBranchCount,
          seatsAfter: sub.additionalSeats,
          actor: 'owner:account-deletion',
        },
      });
    }
    // The free trial (0095): a closed business can never start one. The claim, if there was one, is kept as it is:
    // a fact, like the rest of the subscription's history.
    await tx.trialEligibility.updateMany({
      where: { companyId, closedAt: null },
      data: { closedAt: now, closedReason: 'cancelled' },
    });
    // The subscription messages (0099): nothing more goes to a closed business, and no destination of one is kept. The
    // rows stay, as the rest of its subscription's history does.
    await tx.subscriptionNotice.updateMany({
      where: { companyId, state: { in: ['pending', 'sending'] } },
      data: { state: 'cancelled', cancelReason: 'closed', claimToken: null, claimedUntil: null, completedAt: now },
    });
    await tx.subscriptionNotice.updateMany({ where: { companyId }, data: { destinationMasked: null, destinationHash: null } });

    await tx.company.update({
      where: { id: companyId },
      data: { isActive: false, closedAt: now, publicPhone: null, logoRef: null, isDiscoverable: false, city: null },
    });

    const [sales, purchases, closings, auditRows, subscriptionEvents] = await Promise.all([
      tx.sale.count({ where: { companyId } }),
      tx.purchase.count({ where: { companyId } }),
      tx.dailyClosing.count({ where: { companyId } }),
      tx.auditLog.count({ where: { companyId } }),
      tx.subscriptionEvent.count({ where: { companyId } }),
    ]);
    const receiptKeys = receipts.map((r) => r.receiptKey).filter((k): k is string => !!k);
    return {
      receiptKeys,
      summary: {
        kind: 'company_closure',
        loginsDeleted: people.length,
        ...forgotten,
        customersDeidentified: customers.count,
        suppliersDeidentified: suppliers.count,
        peopleDeidentified: persons.count,
        counterNumbersBlanked: agentNumbers.count,
        receiptsRemoved: receiptKeys.length,
        retained: { sales, purchases, closings, auditRows, subscriptionEvents },
        notRemoved: NOT_REMOVED,
      },
    };
  }

  /**
   * What is removed for each deleted person, wherever their identity was copied (privacy correction,
   * 2026-10-12): the login, a fresh sign-in identifier, every session and device revoked and stripped of where
   * it was used from, every code sent to them masked, their verification intents and pending codes gone, their
   * name on the records they made replaced by "Deleted user" where the record allows it, and their contacts
   * wherever another table copied them (registration, seat requests, codes awaiting verification).
   */
  private async forgetPeople(
    tx: Prisma.TransactionClient,
    companyId: Buffer,
    people: { id: Buffer; email: string | null; phone: string | null }[],
    now: Date,
    actorId: Buffer,
  ): Promise<Record<string, number>> {
    const ids = people.map((p) => p.id);
    const emails = people.map((p) => p.email).filter((c): c is string => !!c);
    const phones = people.map((p) => p.phone).filter((c): c is string => !!c);
    const contacts = [...emails, ...phones];

    for (const p of people) {
      await tx.user.update({ where: { id: p.id }, data: this.deidentified(p.id, now) });
    }
    const sessions = await tx.authSession.updateMany({ where: { userId: { in: ids }, revokedAt: null }, data: { revokedAt: now } });
    await tx.authSession.updateMany({ where: { userId: { in: ids } }, data: { ip: null, userAgent: null, deviceName: null, deviceId: null } });
    const devices = await tx.userDevice.updateMany({
      where: { userId: { in: ids }, revokedAt: null },
      data: { revokedAt: now, revokedById: actorId },
    });
    await tx.userDevice.updateMany({ where: { userId: { in: ids } }, data: { label: null, model: null } });
    await tx.otpChallenge.updateMany({
      where: { userId: { in: ids }, status: OtpStatus.pending },
      data: { status: OtpStatus.cancelled, cancelledAt: now, activeKey: null },
    });
    // Every code ever sent to them: the number it went to is masked. The rows stay, for rate limits and audits.
    await tx.otpChallenge.updateMany({ where: { userId: { in: ids } }, data: { destination: REDACTED_DESTINATION, candidatePhone: null } });
    await tx.verificationIntent.deleteMany({ where: { userId: { in: ids } } });
    if (contacts.length > 0) {
      await tx.contactVerification.deleteMany({ where: { destination: { in: contacts } } });
      for (const column of ['requestedBy', 'confirmedBy', 'closedBy'] as const) {
        await tx.seatAllocation.updateMany({ where: { companyId, [column]: { in: contacts } }, data: { [column]: DELETED_USER_NAME } });
      }
      const registrations: Prisma.RegistrationAttemptWhereInput[] = [];
      if (emails.length > 0) registrations.push({ email: { in: emails } });
      if (phones.length > 0) registrations.push({ phone: { in: phones } });
      // Their applications for this business, or for none yet — never another business's, which the same contact may
      // have applied for and which stays that business's record (review F04).
      await tx.registrationAttempt.updateMany({
        where: { AND: [{ OR: registrations }, { OR: [{ companyId }, { companyId: null }] }] },
        data: { ownerName: DELETED_USER_NAME, email: null, phone: null },
      });
    }
    const devicesSynced = await tx.syncDevice.findMany({ where: { userId: { in: ids } }, select: { deviceId: true } });
    if (devicesSynced.length > 0) await tx.outboxChange.deleteMany({ where: { companyId, deviceId: { in: devicesSynced.map((d) => d.deviceId) } } });
    await tx.syncDevice.deleteMany({ where: { userId: { in: ids } } });
    await tx.ownerInvitation.updateMany({ where: { userId: { in: ids }, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } });

    // Their name on what they recorded, where the record allows it: the counter's exchanges (0092), mistake reports,
    // and the counterparty that was them. Append-only snapshots elsewhere keep theirs (NOT_REMOVED).
    const agentRecords = await tx.agentTransaction.updateMany({ where: { recordedById: { in: ids } }, data: { recordedByName: DELETED_USER_NAME } });
    await tx.agentTransaction.updateMany({ where: { reversedById: { in: ids }, status: 'reversed' }, data: { reversedByName: DELETED_USER_NAME } });
    await tx.agentMistakeReport.updateMany({ where: { reportedById: { in: ids } }, data: { reportedByName: DELETED_USER_NAME } });
    await tx.agentMistakeReport.updateMany({ where: { decidedById: { in: ids } }, data: { decidedByName: DELETED_USER_NAME } });
    await tx.counterparty.updateMany({ where: { companyId, userId: { in: ids } }, data: { name: DELETED_USER_NAME, phone: null, city: null, note: null } });

    return { sessionsRevoked: sessions.count, devicesRevoked: devices.count, counterRecordsRenamed: agentRecords.count };
  }

  private deidentified(userId: Buffer, now: Date): Prisma.UserUpdateInput {
    return {
      name: DELETED_USER_NAME,
      login: deidentifiedLogin(userId),
      // A fresh sign-in identifier: the one the person wrote down leads nowhere now.
      personalId: generatePersonalId(),
      phone: null,
      phoneVerifiedAt: null,
      email: null,
      emailVerifiedAt: null,
      passwordHash: UNUSABLE_PASSWORD_HASH,
      pinHash: null,
      isActive: false,
      deletedAt: now,
    };
  }

  /**
   * The receipt files, once the rows no longer point at them: after the commit, so a rollback never leaves a
   * record pointing at a file already gone. A file that cannot be removed is logged by count and request,
   * never by name — and is the operator's to remove (docs/24 §deletion).
   */
  private async removeFiles(keys: string[], requestId: Buffer): Promise<void> {
    if (keys.length === 0) return;
    if (!this.storage) {
      this.logger.error(`Deletion ${binToUuid(requestId)}: ${keys.length} receipt file(s) not removed — no storage provider`);
      return;
    }
    let failed = 0;
    for (const key of keys) await this.storage.delete(key).catch(() => void failed++);
    if (failed > 0) this.logger.error(`Deletion ${binToUuid(requestId)}: ${failed} of ${keys.length} receipt file(s) could not be removed`);
  }

  /** Best effort, after the commit. A failure here changes nothing and logs no number. */
  private async notifyDeleted(
    destination: string,
    language: MessageLanguage,
    kind: AccountDeletionKind,
    requestId: Buffer,
  ): Promise<void> {
    if (!this.channel.isEnabled) return;
    const lang: MessageLanguage = language in DELETED_WHAT ? language : 'en';
    try {
      const result = await this.channel.send({
        to: destination,
        template: ACCOUNT_DELETED_TEMPLATE.key,
        language: lang,
        variables: { what: DELETED_WHAT[lang][kind] },
        idempotencyKey: `deleted:${binToUuid(requestId)}`,
      });
      if (result.status !== 'accepted') {
        this.logger.warn(`Deletion completion message not accepted for ${binToUuid(requestId)}: ${result.reason}`);
      }
    } catch {
      this.logger.warn(`Deletion completion message failed for ${binToUuid(requestId)}`);
    }
  }

  // ------------------------------------------------------------- internals

  private async reauthenticate(p: DeletionPrincipal, password: string) {
    const user = await this.loadUser(p);
    const ok =
      user && user.isActive ? await this.hashing.verify(user.passwordHash, password) : await this.hashing.verifyDummy(password);
    if (!ok || !user) {
      throw refuse(HttpStatus.UNAUTHORIZED, 'reauthentication_failed', 'That password did not match.');
    }
    return user;
  }

  private loadUser(p: DeletionPrincipal) {
    return this.prisma.user.findFirst({
      where: { id: p.userId, companyId: p.companyId, deletedAt: null },
      select: { id: true, companyId: true, phone: true, phoneVerifiedAt: true, passwordHash: true, isActive: true },
    });
  }

  private latestRequest(p: DeletionPrincipal): Promise<RequestRow | null> {
    return this.prisma.accountDeletionRequest.findFirst({
      where: { companyId: p.companyId, userId: p.userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async openRequest(p: DeletionPrincipal): Promise<RequestRow | null> {
    const latest = await this.latestRequest(p);
    return latest && isOpen(latest.status) ? latest : null;
  }

  private async requireAwaiting(p: DeletionPrincipal): Promise<RequestRow> {
    const open = await this.openRequest(p);
    if (!open) throw refuse(HttpStatus.NOT_FOUND, 'no_open_request', 'There is no deletion request in progress.');
    if (open.status !== 'awaiting_code') {
      throw refuse(HttpStatus.CONFLICT, 'deletion_in_progress', 'This deletion is already being carried out.');
    }
    return open;
  }

  private async send(
    request: RequestRow,
    destination: string,
    language: MessageLanguage,
    idempotencyKey: string,
  ): Promise<DeletionRequestView> {
    const outcome = await this.otp.request({
      companyId: request.companyId,
      userId: request.userId,
      purpose: 'account_deletion',
      destination,
      language,
      idempotencyKey,
    });
    return this.applyOutcome(request, outcome, language);
  }

  /** Record what the code request actually did, and refuse loudly when nothing went out. */
  private async applyOutcome(request: RequestRow, outcome: RequestOutcome, language: MessageLanguage): Promise<DeletionRequestView> {
    if (!outcome.ok) {
      if (outcome.reason === 'rate_limited') {
        throw refuse(HttpStatus.TOO_MANY_REQUESTS, 'too_many_codes', outcome.detail);
      }
      await this.markFailed(request.id, outcome.reason === 'otp_disabled' ? 'delivery_unavailable' : 'no_destination');
      throw refuse(
        HttpStatus.SERVICE_UNAVAILABLE,
        'deletion_unavailable',
        'The deletion code could not be sent. Nothing was changed.',
      );
    }
    const challengeId = uuidToBin(outcome.challenge.challengeId);
    const updated = await this.prisma.accountDeletionRequest.update({
      where: { id: request.id },
      data: {
        challengeId,
        language,
        codeSentAt: outcome.challenge.delivered ? new Date() : request.codeSentAt,
      },
    });
    return this.view(updated);
  }

  private async markFailed(requestId: Buffer, detail: string): Promise<void> {
    await this.prisma.accountDeletionRequest.updateMany({
      where: { id: requestId, status: { in: ['awaiting_code', 'confirmed', 'processing'] } },
      data: { status: 'failed', failureDetail: detail, activeKey: null, version: { increment: 1 } },
    });
  }

  private challengeOf(request: RequestRow): Promise<ChallengeRow | null> {
    if (!request.challengeId) return Promise.resolve(null);
    return this.prisma.otpChallenge.findUnique({ where: { id: request.challengeId } });
  }

  private async audit(
    p: DeletionPrincipal,
    requestId: Buffer,
    action: 'create' | 'status_change',
    after: Record<string, unknown>,
    reason: string,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          companyId: p.companyId,
          userId: p.userId,
          entityType: 'AccountDeletionRequest',
          entityId: requestId,
          action,
          after: after as Prisma.InputJsonValue,
          reason,
        },
      });
    } catch {
      this.logger.warn(`Could not audit account deletion event: ${reason}`);
    }
  }

  private async view(request: RequestRow): Promise<DeletionRequestView> {
    const challenge = request.status === 'awaiting_code' ? await this.challengeOf(request) : null;
    return this.toView(request, challenge);
  }

  private toView(request: RequestRow, challenge: ChallengeRow | null): DeletionRequestView {
    const delivered = challenge?.deliveryState === OtpDeliveryState.accepted;
    const deliveryProblem =
      challenge && challenge.deliveryState !== OtpDeliveryState.accepted && challenge.deliveryState !== OtpDeliveryState.not_sent
        ? challenge.deliveryState
        : null;
    return {
      id: binToUuid(request.id),
      kind: request.kind,
      status: request.status,
      destinationMasked: request.destinationMasked,
      language: request.language,
      createdAt: request.createdAt.toISOString(),
      codeSentAt: request.codeSentAt?.toISOString() ?? null,
      codeExpiresAt: challenge?.expiresAt.toISOString() ?? null,
      attemptsRemaining: challenge ? Math.max(0, challenge.maxAttempts - challenge.attemptCount) : null,
      resendAvailableAt: challenge?.resendNotBefore?.toISOString() ?? null,
      delivered,
      deliveryProblem,
      confirmedAt: request.confirmedAt?.toISOString() ?? null,
      completedAt: request.completedAt?.toISOString() ?? null,
      cancelledAt: request.cancelledAt?.toISOString() ?? null,
      failure: request.failureDetail,
      retained: request.retainedSummary,
    };
  }
}
