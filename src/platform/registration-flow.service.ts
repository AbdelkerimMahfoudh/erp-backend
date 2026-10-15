import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { ContactChannel } from '@prisma/client';
import { RegistrationService } from './registration.service';
import { RegistrationContinuationService, CONTINUATION_TTL_SECONDS } from './registration-continuation.service';
import { ContactDeliveryProvider } from './contact-delivery';
import type { ContinueConfirmDto, ContinueStartDto, RegisterDto } from './registration.dto';

/**
 * A business registering itself — the one flow behind both of its doors (0095, the owner's decision Q1 of
 * 2026-10-13): the website's `platform/register*` and the app's `auth/register*`.
 *
 * Both controllers hand their bodies here and add nothing, so the two doors cannot drift apart: the same refusal
 * before anything is saved, the same continuation, the same session at the end, and the same free trial eligibility —
 * eligible, never started. Starting the trial is the Owner's explicit act on the website, and nothing on either door
 * does it.
 */
@Injectable()
export class RegistrationFlowService {
  constructor(
    private readonly registration: RegistrationService,
    private readonly continuation: RegistrationContinuationService,
    private readonly delivery: ContactDeliveryProvider,
  ) {}

  /** Create the business, its Owner and its pending subscription, and hand back the continuation that finishes it. */
  async register(dto: RegisterDto) {
    /*
     * Before anything is created (2026-10-05). A registration can only finish
     * by proving the contact, so a server that cannot send that code must
     * refuse here — not create a pending business whose Owner then waits for a
     * code that is never coming, and can sign in to *Waiting for activation*
     * meanwhile (`docs/67` RC-02). The same rule the deletion flow follows
     * (`56bddbe`): refused up front, and nothing was saved.
     *
     * Every contact given, not only the first (C10; review finding R2-3): each
     * one given must be verified (the owner's rule of 2026-10-15), and the free
     * trial waits for all of them — so a number whose code cannot leave this
     * server would leave a business that can never claim. The refusal names
     * which ones, so the person can drop that contact and continue.
     */
    const given = (['email', 'phone'] as const).filter((channel) => (channel === 'email' ? dto.email : dto.phone)?.trim());
    const unavailable: ContactChannel[] = given.filter((channel) => !this.delivery.canDeliver(channel));
    if (unavailable.length > 0) {
      throw new ServiceUnavailableException({
        code: 'registration_unavailable',
        message: 'Registration cannot be completed right now: a verification code cannot be sent to every contact given. Nothing was saved.',
        unavailableContacts: unavailable,
      });
    }

    const result = await this.registration.register({
      idempotencyKey: dto.idempotencyKey,
      ownerName: dto.ownerName,
      businessName: dto.businessName,
      branchName: dto.branchName,
      activity: dto.activity,
      city: dto.city,
      email: dto.email,
      phone: dto.phone,
      password: dto.password,
      language: dto.language,
      // A business that registers itself may claim one free trial (0095). Eligible — not started.
      trialEligible: true,
    });

    /*
     * A continuation, never a session.
     *
     * Registration proves somebody filled a form. It does not prove they can
     * read the address they typed, so it cannot be the thing that signs them
     * in. The continuation carries the attempt forward and buys exactly one
     * thing: the completion of THIS registration, once, after the code bound to
     * it is proved.
     *
     * Issued only for a registration that is still incomplete. A retry that
     * recognises an already-completed registration gets no new credential —
     * otherwise a public idempotency key would be a way to mint one.
     */
    const owner = await this.registration.pendingOwnerFor(result.companyId);
    const continuation = owner
      ? await this.continuation.issue(owner.companyId, owner.userId)
      : null;

    return {
      status: result.status,
      created: result.created,
      publicStoreId: result.publicStoreId,
      /** The first branch's activity as recorded (D154) — on a retry, what the winner recorded. */
      activity: result.activity,
      /** Whether the business holds an unused free trial (0095): eligible and not started — never a trial running. */
      trialEligible: result.trialEligible,
      /** Where the code will go. From the OWNER RECORD, not from the request. */
      verification: owner ? { destination: owner.destinationMasked, channel: owner.channel } : null,
      continuation: continuation
        ? {
            token: continuation.token,
            expiresAt: continuation.expiresAt,
            expiresInSeconds: CONTINUATION_TTL_SECONDS,
          }
        : null,
      next: continuation ? 'verify_contact' : 'sign_in',
    };
  }

  /**
   * Send the code for THIS registration, and bind the challenge to it.
   *
   * Public because it runs before any session exists, but not open: it does
   * nothing without a valid continuation, and the destination comes from the
   * Owner record rather than the request, so a stolen continuation cannot
   * redirect a code somewhere else.
   */
  async startVerification(dto: ContinueStartDto) {
    const result = await this.continuation.startChallenge(dto.continuation, dto.language);
    if (!result.ok) {
      // One shape for every refusal: a caller must not be able to tell an
      // expired continuation from an unknown one, or probe which addresses
      // exist.
      throw new BadRequestException('That registration cannot be continued.');
    }
    return { delivery: result.delivery };
  }

  /**
   * Prove the code and finish, receiving one ordinary Owner session.
   *
   * The session comes from `SessionsService` exactly as a password sign-in
   * would. It carries no extra authority, no platform-administrator rights, and
   * the subscription stays pending — being signed in is not being entitled, and
   * an eligible business's free trial is still not started.
   */
  async confirmVerification(dto: ContinueConfirmDto, context: { ip?: string; userAgent?: string }) {
    const result = await this.continuation.complete(dto.continuation, dto.code, context);
    if (!result.ok) {
      throw new BadRequestException('That code did not match.');
    }
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
    };
  }
}
