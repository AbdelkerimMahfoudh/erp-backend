import { BadRequestException, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import type { ContactChannel } from '@prisma/client';
import { normalisePhone } from '../auth/identifier';
import { WhatsAppRecords } from '../messaging/whatsapp-records';
import { acceptedConsentVersion, consentLocaleOf, type ConsentSource } from '../messaging/whatsapp-consent';
import { RegistrationService } from './registration.service';
import { RegistrationContinuationService, CONTINUATION_TTL_SECONDS } from './registration-continuation.service';
import { ContactDeliveryProvider } from './contact-delivery';
import type { ContinueConfirmDto, ContinueStartDto, RegisterDto } from './registration.dto';
import { AcquisitionService, AcquisitionUnavailableException } from '../acquisition/acquisition.service';

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
    @Optional() private readonly whatsappRecords?: WhatsAppRecords,
    @Optional() private readonly acquisition?: AcquisitionService,
  ) {}

  /**
   * Create the business, its Owner and its pending subscription, and hand back the continuation that finishes it.
   * `door` is the controller's, never the request's: where the WhatsApp consent was given, and the address it came from.
   */
  async register(dto: RegisterDto, door: { source: Extract<ConsentSource, 'mobile_registration' | 'website_registration'>; ip?: string | null }) {
    /*
     * Before anything is created (2026-10-05). A registration can only finish
     * by proving the contact, so a server that cannot send that code must
     * refuse here — not create a pending business whose Owner then waits for a
     * code that is never coming, and can sign in to *Waiting for activation*
     * meanwhile (`docs/67` RC-02). The same rule the deletion flow follows
     * (`56bddbe`): refused up front, and nothing was saved.
     *
     * The WhatsApp number is the contact (0099; the owner's brief of
     * 2026-10-18): mandatory, verified here, and what the free trial waits for.
     * An email address given beside it is optional, verified later from the
     * account if the Owner wants it, and asks nothing of this server now — so
     * only the number can refuse a registration.
     */
    const phone = dto.phone?.trim() ? normalisePhone(dto.phone) : null;
    if (!phone) {
      throw new BadRequestException('Give your WhatsApp number — it is how your account is verified and how Dukan ERP reaches you.');
    }
    /*
     * The operational WhatsApp consent (D213), checked before anything is saved, in every mode: no registration
     * finishes without the person's explicit agreement to the copy in force — never inferred from the number being
     * typed or, later, verified. A missing or earlier version is refused with nothing saved.
     */
    const consentVersion = acceptedConsentVersion(dto.whatsappConsentVersion);
    const consentLocale = consentLocaleOf(dto.whatsappConsentLocale, dto.language);
    if (!this.whatsappRecords) {
      throw new ServiceUnavailableException({
        code: 'registration_unavailable',
        message: 'Registration cannot be completed right now: the WhatsApp consent cannot be recorded. Nothing was saved.',
      });
    }
    if (!this.delivery.canDeliver('phone', phone)) {
      const unavailableContacts: ContactChannel[] = ['phone'];
      throw new ServiceUnavailableException({
        code: 'registration_unavailable',
        message: 'Registration cannot be completed right now: a verification code cannot be sent to this WhatsApp number. Nothing was saved.',
        unavailableContacts,
      });
    }

    /*
     * Where the business came from (0103, D221), if anywhere: at most one source, and a caller who has spent their
     * wrong guesses cannot use the registration as one more. A source refused inside the registration counts as one.
     */
    const claimed = { promoCode: dto.promoCode, referralToken: dto.referralToken };
    if (!this.acquisition && (claimed.promoCode?.trim() || claimed.referralToken?.trim())) {
      throw new AcquisitionUnavailableException(claimed.promoCode?.trim() ? 'promoter' : 'user_invite');
    }
    const acquisition = this.acquisition?.claimOf(claimed) ?? null;
    if (acquisition) this.acquisition!.assertMayClaim(door.ip);

    const result = await this.registration.register({
      idempotencyKey: dto.idempotencyKey,
      ownerName: dto.ownerName,
      ownerNameAr: dto.ownerNameAr,
      businessName: dto.businessName,
      businessNameAr: dto.businessNameAr,
      branchName: dto.branchName,
      branchNameAr: dto.branchNameAr,
      activity: dto.activity,
      city: dto.city,
      email: dto.email,
      phone: dto.phone,
      password: dto.password,
      language: dto.language,
      // A business that registers itself may claim one free trial (0095). Eligible — not started.
      trialEligible: true,
      acquisition,
    }).catch((e: unknown) => {
      if (e instanceof AcquisitionUnavailableException) this.acquisition?.recordRefusedClaim(door.ip);
      throw e;
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
    // The agreement is recorded against the Owner it belongs to, with the language it was shown in and an audit event,
    // before the code is sent — PENDING (D213): it authorises only that code, and becomes the consent in force only when
    // the number is verified. A retry of the same registration writes nothing new: it is the same agreement.
    if (owner) {
      await this.whatsappRecords.recordPending({
        number: phone,
        version: consentVersion,
        locale: consentLocale,
        companyId: owner.companyId,
        userId: owner.userId,
        source: door.source,
        ip: door.ip ?? null,
      });
    }
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
