-- ===========================================================================
-- 0115_platform_admin_invitation (the owner's brief of 2026-11-01)
--
-- A second platform administrator is invited, never created with a password
-- somebody else chose. The invited person spends a one-time setup code, once, to
-- choose their own password, then enrols their own authenticator; only then is
-- the account active.
--
-- `admin_state`, explicit, so access never rests on an unknown password or a
-- missing factor alone:
--   invited    a setup code is outstanding; no sign-in at all
--   enrolling  the code was spent and the password chosen; a sign-in reaches the
--              two enrolment routes and nothing else
--   active     every existing administrator, and an invited one once enrolled
-- The setup code is stored as a keyed digest only (HMAC-SHA256 under
-- PLATFORM_MFA_KEY, its own domain), with its expiry; both are present exactly
-- while the account is `invited`.
--
-- Additive: one column with a default every existing row takes ('active', so the
-- current administrator is unchanged), two nullable columns, two CHECKs. No row
-- is rewritten beyond the default, nothing dropped, no index touched.
--
-- Reverse: the API from before this migration ignores the columns and would let
-- an `invited` or `enrolling` row sign in like any other (its unknown password
-- or missing factor still stand in the way, but not the state). So before
-- rolling the code back: revoke every non-active invitation
-- (`admin-invitation.sh revoke`), then the columns may stay or be dropped
-- (DROP the two CHECKs, then the three columns).
-- ===========================================================================

ALTER TABLE `platform_admins`
  ADD COLUMN `admin_state` VARCHAR(16) NOT NULL DEFAULT 'active' AFTER `name`,
  ADD COLUMN `setup_code_hash` CHAR(64) NULL AFTER `admin_state`,
  ADD COLUMN `setup_code_expires_at` DATETIME(6) NULL AFTER `setup_code_hash`,
  ADD CONSTRAINT `ck_platform_admins_state` CHECK (`admin_state` IN ('invited', 'enrolling', 'active')),
  ADD CONSTRAINT `ck_platform_admins_setup_code` CHECK (
    (`admin_state` = 'invited') = (`setup_code_hash` IS NOT NULL)
    AND (`setup_code_hash` IS NULL) = (`setup_code_expires_at` IS NULL)
  );
