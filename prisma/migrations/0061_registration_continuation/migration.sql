-- ===========================================================================
-- 0061 — a purpose for finishing a registration.
--
-- **One enum value. No new table, and no new credential store.** Same argument
-- as `0060`, and for the same reason: the hard part is single-use consumption
-- under concurrency, `verification_intents` already implements and tests it,
-- and a second table of the same shape would be a second chance to get it
-- wrong.
--
-- ## What this purpose is for
--
-- Creating an account on the phone ends with the Owner signed in. Registration
-- returns no session, and the registration password is deliberately never
-- replayed to simulate a login, so something has to carry authority from "this
-- person just created this company" to "this person is now signed in".
--
-- That something must not be a fact about a contact address. Asking only
-- whether a destination has ever been verified would let anyone who once
-- verified an address mint an Owner session for whoever owns it now — no
-- password involved. The chain has to be:
--
--     one registration attempt
--   + one short-lived continuation credential
--   + one verification challenge bound to that attempt
--   + successful consumption of that exact challenge
--   = one normal Owner session
--
-- `verification_intents` already carries every link of that chain:
-- `company_id` and `user_id` bind the attempt's Owner, `challenge_id` binds the
-- exact challenge, `token_hash` stores nothing replayable, `expires_at` keeps
-- it short-lived and `consumed_at` makes it single-use.
--
-- ## Why a DISTINCT purpose, and not `portal_handoff`
--
-- Security, not tidiness. `resolve()` matches on purpose, so sharing one value
-- would make a portal ticket and a registration continuation interchangeable:
-- a ticket minted to open a subscription page could be spent to complete
-- somebody's registration, and the reverse. They authorise different things and
-- must not be substitutable.
--
-- Additive: existing rows keep their value, and the four existing purposes are
-- listed first so their stored ordinals do not move. Nothing is dropped and no
-- row is rewritten. The column stays NOT NULL with no default.
--
-- Reverse (safe only while no row holds the new value):
--   ALTER TABLE `verification_intents`
--     MODIFY `purpose` ENUM('phone_verification','device_verification',
--                           'logout_reauth','portal_handoff') NOT NULL;
-- ===========================================================================

ALTER TABLE `verification_intents`
  MODIFY `purpose` ENUM(
    'phone_verification',
    'device_verification',
    'logout_reauth',
    'portal_handoff',
    'registration_continuation'
  ) NOT NULL;
