-- ===========================================================================
-- 0096 — A claimed free trial retires the setup links it did not use (docs/76).
--
-- Why: the trial starts only when the Owner confirms it on the website, with or without the link the setup
-- instructions carried — the link is a convenience, never the only way (the owner's clarification of 2026-10-13).
-- Once a trial has started, no link sent for it may still read as valid: the claim consumes the link it was made
-- with, if any, and revokes every other unused link of the business. That revocation needs a reason of its own,
-- `claimed`: none of 0095's is true of it — nothing was reissued, nobody signed out, no contact or password changed.
-- 0095 is not edited: it is already applied (with its checksum) on the disposable databases that rehearsed it.
--
-- Additive: one ENUM value, APPENDED, so no stored value moves and MySQL changes the column's definition only.
-- Reverse — only while no row holds the value (SELECT COUNT(*) FROM `trial_setup_links` WHERE `revoked_reason` =
-- 'claimed' must answer 0; this server's empty sql_mode would otherwise blank those reasons to ''):
--   ALTER TABLE `trial_setup_links` MODIFY `revoked_reason` ENUM('reissued','signed_out_everywhere','contact_changed','password_changed','deleted','closed') NULL;
-- ===========================================================================

ALTER TABLE `trial_setup_links`
  MODIFY `revoked_reason` ENUM('reissued','signed_out_everywhere','contact_changed','password_changed','deleted','closed','claimed') NULL;
