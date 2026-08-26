-- ===========================================================================
-- 0060 — a purpose for the mobile → website portal handoff.
--
-- **One enum value. No new table, and no new credential store.**
--
-- The handoff needs a ticket that is high-entropy, stored only as a hash,
-- bound to one company and one user, short-lived, and consumable exactly once
-- even under concurrent taps. `verification_intents` already is all of those
-- things, and its single-use consumption — a conditional `UPDATE ... WHERE
-- consumed_at IS NULL` — is already covered by tests. Building a second table
-- with the same shape would mean a second implementation of the part that must
-- not be got wrong.
--
-- So the handoff reuses that model and only needs a purpose to sit under.
--
-- Additive: existing rows keep their value, and the three existing purposes are
-- listed first so their stored ordinals do not move. Nothing is dropped and no
-- row is rewritten.
--
-- The column is NOT NULL with no default, exactly as before.
-- ===========================================================================

ALTER TABLE `verification_intents`
  MODIFY `purpose` ENUM(
    'phone_verification',
    'device_verification',
    'logout_reauth',
    'portal_handoff'
  ) NOT NULL;
