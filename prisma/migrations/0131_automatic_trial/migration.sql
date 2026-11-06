-- 0131: the free trial starts automatically when a self-registration completes (owner's brief, 2026-11-06). Additive.
--
-- The trial itself needs no new column: an automatic start is a `trial_claims` row like a claimed one (one per business,
-- 168 hours from its instant), its idempotency key `auto:<company>` marking how it began. One notice kind is added:
--   * `subscription_notices.kind` gains `trial_started` — the Owner's WhatsApp message that the trial is active, created
--     in the trial's own transaction and deduplicated by business (`period_key = trial_start`, `threshold = start`).
-- Rollback: drop the value only once no row uses it (see docs/121).

ALTER TABLE `subscription_notices`
  MODIFY `kind` ENUM('portal_instructions','trial_reminder','trial_expired','paid_reminder','paid_expired','grace_reminder','grace_ended','branch_activation','trial_started') NOT NULL;
