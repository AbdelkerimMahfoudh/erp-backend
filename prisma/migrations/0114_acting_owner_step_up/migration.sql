-- ===========================================================================
-- 0114_acting_owner_step_up (D225, the owner's brief of 2026-10-30)
--
-- Appointing, changing or removing an Acting Owner asks for the Owner's
-- password and a one-time code sent to the Owner's verified WhatsApp number:
-- the existing OtpService, as account deletion uses it. This gives that code a
-- purpose of its own.
--
-- Why a purpose of its own: `OtpService.verify` and `resolve()` match on the
-- purpose, so a code issued for a sign-in re-verification, a phone, a device or
-- a deletion can never confirm an appointment, and an appointment's code can
-- never pass any of those checks. Borrowing `logout_reauth` relied on the
-- challenge's idempotency key alone for that separation.
--
-- Additive: one value appended to the two purpose enums (the same pair 0084
-- widened together). No row changes, nothing dropped, no index touched.
--
-- Reverse: safe to leave. Narrowing back needs no row to hold
-- `acting_owner_step_up` (DELETE those challenges first, they are short-lived
-- and single-use), then the two MODIFYs without the value.
-- ===========================================================================

ALTER TABLE `otp_challenges`
  MODIFY `purpose` ENUM(
    'phone_verification',
    'device_verification',
    'logout_reauth',
    'portal_handoff',
    'registration_continuation',
    'account_deletion',
    'acting_owner_step_up'
  ) NOT NULL;

ALTER TABLE `verification_intents`
  MODIFY `purpose` ENUM(
    'phone_verification',
    'device_verification',
    'logout_reauth',
    'portal_handoff',
    'registration_continuation',
    'account_deletion',
    'acting_owner_step_up'
  ) NOT NULL;
