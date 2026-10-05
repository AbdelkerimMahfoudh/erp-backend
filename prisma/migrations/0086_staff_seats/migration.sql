-- ===========================================================================
-- 0086 — Staff accounts that wait to be activated, and seats that belong to a
--        store (docs/21, 2026-10-05; docs/68).
--
-- Why: the approved commercial rule changed. Every store now includes ONE
-- staff seat (the Owner never counts); each further seat at that store costs
-- 100 MRU per month, charged in full; a person working at two stores holds a
-- seat at each. That replaces two included staff per branch pooled across the
-- company. And an employee account created by an Owner is no longer usable
-- the moment it exists: it waits until every contact the Owner selected is
-- verified by the person who holds it AND a seat is held at each of its
-- stores — paid and confirmed by an administrator with a reference, included,
-- or granted. The server decides; no client is trusted with any of it.
--
-- ## What this adds
--
-- 1. `users.invited_at` / `users.activated_at`. An account with `invited_at`
--    set and `activated_at` NULL is PENDING: `is_active` stays 0, so it can
--    neither sign in nor be counted as a seat, by construction. Every account
--    that existed before this migration is backfilled `activated_at =
--    created_at`: nobody who already worked here reads as pending, and nobody
--    is deactivated.
--
-- 2. `seat_allocations`: one row per additional seat (at one store) or per
--    additional store. `pending_payment` grants nothing; `paid` requires a
--    recorded payment with a reference (`payment_id`); `granted` is a seat
--    held without a charge — the transition carries staff who already worked
--    above the included seat as granted seats, so the rule change charges
--    nothing retroactively. `version` is the optimistic guard: two
--    confirmations of one request produce one payment and one refusal.
--
-- 3. Five `subscription_events.kind` values, so the timeline every Owner and
--    administrator reads shows seat requests, confirmed payments, activations
--    and closures in order.
--
-- 4. Plan version 2, in force from the moment this migration runs: 500 MRU per
--    store, ONE included seat per store, 100 MRU per additional seat. Periods
--    already open keep the unit prices copied into them and their assessed
--    high-water mark, so nothing already invoiced moves.
--
-- Additive: two nullable columns with a backfill, one new table, one enum
-- widening, one data row. Nothing is dropped and no existing row changes
-- meaning.
--
-- Reverse:
--   DELETE FROM `plan_versions` WHERE `id` = UNHEX('00000000000000000000000000000002');
--   DROP TABLE `seat_allocations`;
--   ALTER TABLE `subscription_events` MODIFY `kind` ENUM('created','extended','branches_changed','seats_changed','complimentary_granted','complimentary_revoked','backfilled','registered','administrative_grant','suspended','reinstated','cancelled','approved','rejected','period_corrected') NOT NULL;
--   ALTER TABLE `users` DROP COLUMN `activated_at`, DROP COLUMN `invited_at`;
-- (Only after deleting any subscription_events rows carrying the five new kinds.)
-- ===========================================================================

-- 1. Pending accounts -------------------------------------------------------
ALTER TABLE `users`
  ADD COLUMN `invited_at` DATETIME(6) NULL AFTER `is_active`,
  ADD COLUMN `activated_at` DATETIME(6) NULL AFTER `invited_at`;

-- Everybody who existed before this rule was usable before it: none may read as pending.
UPDATE `users` SET `activated_at` = `created_at` WHERE `activated_at` IS NULL;

-- 3. The timeline learns the new events --------------------------------------
ALTER TABLE `subscription_events`
  MODIFY `kind` ENUM('created','extended','branches_changed','seats_changed','complimentary_granted','complimentary_revoked','backfilled','registered','administrative_grant','suspended','reinstated','cancelled','approved','rejected','period_corrected','seat_requested','seat_paid','staff_activated','seat_closed','store_requested') NOT NULL;

-- 2. Seats and stores beyond the included ones -------------------------------
CREATE TABLE `seat_allocations` (
  `id`              BINARY(16)   NOT NULL,
  `company_id`      BINARY(16)   NOT NULL,
  `subscription_id` BINARY(16)   NOT NULL,
  `branch_id`       BINARY(16)   NULL,
  `user_id`         BINARY(16)   NULL,
  `kind`            ENUM('seat','store') NOT NULL,
  `status`          ENUM('pending_payment','paid','granted','released','refused') NOT NULL DEFAULT 'pending_payment',
  `label`           VARCHAR(160) NULL,
  `monthly_amount`  INT UNSIGNED NOT NULL,
  `currency`        CHAR(3)      NOT NULL DEFAULT 'MRU',
  `requested_by`    VARCHAR(160) NOT NULL,
  `requested_at`    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `payment_id`      BINARY(16)   NULL,
  `confirmed_by`    VARCHAR(160) NULL,
  `confirmed_at`    DATETIME(6)  NULL,
  `closed_at`       DATETIME(6)  NULL,
  `closed_by`       VARCHAR(160) NULL,
  `reason`          VARCHAR(500) NULL,
  `version`         INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`      DATETIME(6)  NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `ix_seat_alloc_company_status` (`company_id`, `status`),
  INDEX `ix_seat_alloc_branch_status` (`branch_id`, `status`),
  INDEX `ix_seat_alloc_user` (`user_id`),
  INDEX `ix_seat_alloc_status_requested` (`status`, `requested_at`),
  CONSTRAINT `fk_seat_alloc_company`      FOREIGN KEY (`company_id`)      REFERENCES `companies` (`id`)             ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_seat_alloc_subscription` FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions` (`id`)         ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_seat_alloc_branch`       FOREIGN KEY (`branch_id`)       REFERENCES `branches` (`id`)              ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_seat_alloc_user`         FOREIGN KEY (`user_id`)         REFERENCES `users` (`id`)                 ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_seat_alloc_payment`      FOREIGN KEY (`payment_id`)      REFERENCES `subscription_payments` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 4. The approved rule, in force from now ------------------------------------
INSERT INTO `plan_versions`
  (`id`, `plan_key`, `version`, `branch_monthly`, `included_staff_per_branch`,
   `extra_staff_monthly`, `effective_from`, `created_by`, `reason`)
SELECT
  UNHEX('00000000000000000000000000000002'), 'standard', COALESCE(MAX(`version`), 0) + 1, 500, 1, 100,
  UTC_TIMESTAMP(6), 'migration 0086',
  'Approved 2026-10-05 (docs/21): 500 MRU per store per month; ONE included staff seat per store, the Owner excluded; each additional seat 100 MRU per store per month, charged in full. Staff above the included seat on that date are carried as granted seats by the transition.'
FROM `plan_versions`
WHERE `plan_key` = 'standard'
  AND NOT EXISTS (SELECT 1 FROM (SELECT `id` FROM `plan_versions` WHERE `id` = UNHEX('00000000000000000000000000000002')) AS existing);
