-- 0130: a new branch requested from the app (owner's brief, 2026-11-05). Additive and narrow.
--
-- A branch the Owner adds in the app is a store request (`seat_allocations`, kind `store`) awaiting activation: no
-- `branches` row exists until the platform approves its payment, so no operational route can sell, receive, hold money,
-- take staff or select it, and it holds no seat. Two columns and one notice kind carry what the request now needs:
--   * `location`: the optional city or location label the Owner gave, copied to `branches.address` when it opens;
--   * `request_key`: the app's idempotency key — a double tap, a retry or an uncertain network outcome returns the one
--     request made, unique per business (NULL for requests made before 0130 and from the portal);
--   * `subscription_notices.kind` gains `branch_activation`: the Owner's WhatsApp notice that the new branch is ready
--     for activation, created after the request commits and deduplicated by request (`period_key = branch:<id>`).

ALTER TABLE `seat_allocations`
  ADD COLUMN `location` VARCHAR(160) NULL AFTER `label_ar`,
  ADD COLUMN `request_key` VARCHAR(80) NULL AFTER `location`,
  ADD UNIQUE KEY `ux_seat_allocations_request_key` (`company_id`, `request_key`);

ALTER TABLE `subscription_notices`
  MODIFY `kind` ENUM('portal_instructions','trial_reminder','trial_expired','paid_reminder','paid_expired','grace_reminder','grace_ended','branch_activation') NOT NULL;
