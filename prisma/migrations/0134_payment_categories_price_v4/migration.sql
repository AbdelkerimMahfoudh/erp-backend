-- 0134 (owner, 2026-11-08): one price list everywhere, and what each payment is for.
--
-- 1. Price version 4, in force from now: electronics store 600 MRU a month, money services agent 300, a store doing
--    both 800 (never the sum), one included seat per store, each additional seat 100 MRU a month. The portal's period
--    offers (1/3/12 months: 600 / 1 500 / 5 000 for electronics) were already these figures (docs/21, 2026-11-05);
--    the monthly engine (pricing-rules.ts) still priced 500/300/700. Periods opened before keep their own copied
--    prices; nothing is re-priced retroactively.
-- 2. A payment and a payment proof say what they pay for: `subscription` (stores, 1/3/12 months), `store_activation`
--    (a store added in the app), `extra_seats` (seats at one store), `other` (an adjustment, with its note).
--    NULL = recorded before 0134. Additive; older code ignores the columns, so no rollback floor.

INSERT INTO `plan_versions`
  (`id`, `plan_key`, `version`, `branch_monthly`, `agent_monthly`, `both_monthly`, `included_staff_per_branch`,
   `extra_staff_monthly`, `effective_from`, `created_by`, `reason`)
SELECT
  UNHEX('00000000000000000000000000000004'), 'standard', COALESCE(MAX(`version`), 0) + 1, 600, 300, 800, 1, 100,
  UTC_TIMESTAMP(6), 'migration 0134',
  'Approved by the owner 2026-11-05/2026-11-08: per store per month — electronics 600 MRU, money services agent 300 MRU, both 800 MRU (never the sum); one included seat per store, each additional seat 100 MRU per store per month. The portal sells 1, 3 or 12 months (electronics 600 / 1 500 / 5 000).'
FROM `plan_versions`
WHERE `plan_key` = 'standard'
  AND NOT EXISTS (SELECT 1 FROM (SELECT `id` FROM `plan_versions` WHERE `id` = UNHEX('00000000000000000000000000000004')) AS existing);

ALTER TABLE `payment_proofs`
  ADD COLUMN `category` ENUM('subscription','store_activation','extra_seats','other') NULL AFTER `months`,
  ADD COLUMN `seats` INT UNSIGNED NULL AFTER `category`;

ALTER TABLE `subscription_payments`
  ADD COLUMN `category` ENUM('subscription','store_activation','extra_seats','other') NULL AFTER `channel`,
  ADD COLUMN `details` JSON NULL AFTER `category`;
