-- ===========================================================================
-- 0088 — The Money Services Agent activity, chosen and priced per branch
--        (docs/73 §3, D154, 2026-10-08).
--
-- Why: a branch is now subscribed to an ACTIVITY — the electronics store
-- (500 MRU per month, as today), the money services agent counter (300), or
-- both (700 — never 500 + 300). The quote's branch fee becomes the sum of
-- each branch's activity price; the seat rules of 2026-10-05 are untouched.
-- An upgrade during a paid month is charged for the difference at once; a
-- downgrade waits for the next renewal. Every branch that exists today is
-- `electronics`, so no invoice moves.
--
-- ## What this adds
--
-- 1. `branches.activity` (default `electronics`), `branches.activity_next`
--    (a downgrade waiting for the renewal) and `branches.activity_changed_at`.
-- 2. `plan_versions.agent_monthly` / `both_monthly`, copied into
--    `billing_periods` like the other unit prices; existing rows carry the
--    approved figures as their default, so an old period still re-prices
--    with its own copied numbers. `billing_periods.assessed_activity_fee_by_branch`
--    keeps the per-branch assessment so an upgrade's difference is its own.
-- 3. `seat_allocations.kind` gains `activity` with `activity_from`,
--    `activity_to` and `activity_effective` (`now` for an upgrade charged at
--    once, `renewal` for a downgrade); a store request records the new
--    store's activity in `activity_to`.
-- 4. `subscription_events.kind` gains the four activity and renewal events.
-- 5. Plan version 3: 500 / 300 / 700 / 1 included seat / 100 per extra seat,
--    in force from now — exactly as 0086 inserted version 2.
--
-- Additive. Reverse, for a database you would rather not restore:
--   DELETE FROM `plan_versions` WHERE `id` = UNHEX('00000000000000000000000000000003');
--   ALTER TABLE `subscription_events` MODIFY `kind` ENUM('created','extended','branches_changed','seats_changed','complimentary_granted','complimentary_revoked','backfilled','registered','administrative_grant','suspended','reinstated','cancelled','approved','rejected','period_corrected','seat_requested','seat_paid','staff_activated','seat_closed','store_requested') NOT NULL;
--   ALTER TABLE `seat_allocations` DROP COLUMN `activity_effective`, DROP COLUMN `activity_to`, DROP COLUMN `activity_from`, MODIFY `kind` ENUM('seat','store') NOT NULL;
--   ALTER TABLE `billing_periods` DROP COLUMN `assessed_activity_fee_by_branch`, DROP COLUMN `both_monthly`, DROP COLUMN `agent_monthly`;
--   ALTER TABLE `plan_versions` DROP COLUMN `both_monthly`, DROP COLUMN `agent_monthly`;
--   ALTER TABLE `branches` DROP COLUMN `activity_changed_at`, DROP COLUMN `activity_next`, DROP COLUMN `activity`;
-- ===========================================================================

-- 1. The branch's activity -----------------------------------------------------
ALTER TABLE `branches`
  ADD COLUMN `activity`            ENUM('electronics','money_agent','both') NOT NULL DEFAULT 'electronics' AFTER `type`,
  ADD COLUMN `activity_next`       ENUM('electronics','money_agent','both') NULL AFTER `activity`,
  ADD COLUMN `activity_changed_at` DATETIME(6) NULL AFTER `activity_next`;

-- 2. The prices, on the plan and copied into each period -----------------------
ALTER TABLE `plan_versions`
  ADD COLUMN `agent_monthly` INT UNSIGNED NOT NULL DEFAULT 300 AFTER `branch_monthly`,
  ADD COLUMN `both_monthly`  INT UNSIGNED NOT NULL DEFAULT 700 AFTER `agent_monthly`;

ALTER TABLE `billing_periods`
  ADD COLUMN `agent_monthly`                   INT UNSIGNED NOT NULL DEFAULT 300 AFTER `branch_monthly`,
  ADD COLUMN `both_monthly`                    INT UNSIGNED NOT NULL DEFAULT 700 AFTER `agent_monthly`,
  ADD COLUMN `assessed_activity_fee_by_branch` JSON NULL AFTER `extra_staff_monthly`;

-- 3. Activity requests, beside seat and store requests -------------------------
ALTER TABLE `seat_allocations`
  MODIFY `kind` ENUM('seat','store','activity') NOT NULL,
  ADD COLUMN `activity_from`      ENUM('electronics','money_agent','both') NULL AFTER `label`,
  ADD COLUMN `activity_to`        ENUM('electronics','money_agent','both') NULL AFTER `activity_from`,
  ADD COLUMN `activity_effective` ENUM('now','renewal') NULL AFTER `activity_to`;

-- 4. The events --------------------------------------------------------------
ALTER TABLE `subscription_events`
  MODIFY `kind` ENUM('created','extended','branches_changed','seats_changed','complimentary_granted','complimentary_revoked','backfilled','registered','administrative_grant','suspended','reinstated','cancelled','approved','rejected','period_corrected','seat_requested','seat_paid','staff_activated','seat_closed','store_requested','activity_requested','activity_changed','activity_scheduled','renewed') NOT NULL;

-- 5. The approved prices, in force from now -----------------------------------
INSERT INTO `plan_versions`
  (`id`, `plan_key`, `version`, `branch_monthly`, `agent_monthly`, `both_monthly`, `included_staff_per_branch`,
   `extra_staff_monthly`, `effective_from`, `created_by`, `reason`)
SELECT
  UNHEX('00000000000000000000000000000003'), 'standard', COALESCE(MAX(`version`), 0) + 1, 500, 300, 700, 1, 100,
  UTC_TIMESTAMP(6), 'migration 0088',
  'Approved 2026-10-08 (docs/21 D154): per branch per month — electronics store 500 MRU, money services agent 300 MRU, both 700 MRU (never the sum); one included staff seat per store, the Owner excluded; each additional seat 100 MRU per store per month. An upgrade during a paid month charges the difference at once; a downgrade takes effect at the next renewal.'
FROM `plan_versions`
WHERE `plan_key` = 'standard'
  AND NOT EXISTS (SELECT 1 FROM (SELECT `id` FROM `plan_versions` WHERE `id` = UNHEX('00000000000000000000000000000003')) AS existing);
