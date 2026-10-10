-- ===========================================================================
-- 0091 — Money-agent stabilization (docs/73 §11, D158–D161, 2026-10-10).
--
-- Why: four things the money-agent activity needs before a phone tests it.
--   * The owner's binding billing decisions: a store that replaces an archived
--     one in the same paid period costs no second base fee (the activity
--     difference when dearer), and that decision must be linked, immutably, to
--     the archived store, the replacement and the amount — once per slot, even
--     when two requests race.
--   * A closing must notice money that moved after it was loaded: every money
--     write bumps a counter on the business day's row under the lock the close
--     takes, and the close compares it.
--   * The Owner's provider settings and float amounts must be safe to retry: a
--     lost answer retried later must not write a second version or re-anchor a
--     float after the legs it should have counted.
--
-- ## What this adds
--
-- 1. `daily_closings.money_version` — bumped by every money write on that
--    business day, inside the writer's transaction, under the day row's lock.
--    0 on every existing row: a closed day keeps the version it was closed on.
-- 2. `seat_allocations.replaces_branch_id`, `replacement_credit`,
--    `replacement_period_id` — the slot a store request reserved: the archived
--    branch, the fee this period already paid for it, and the period.
-- 3. `branch_replacements` — append-only: one row per replacement actually
--    made, linking the archived branch, the replacement, the request, the
--    period, the fees and the decision. UNIQUE per (period, archived branch)
--    and per replacement branch, so a slot is consumed once.
-- 4. `agent_request_keys` — append-only: the idempotency key of each provider,
--    configuration and float-position write, with its request fingerprint and
--    the answer it gave. UNIQUE per (company, key).
--
-- Additive. Reverse, for a database you would rather not restore:
--   DROP TABLE `agent_request_keys`, `branch_replacements`;
--   ALTER TABLE `seat_allocations` DROP FOREIGN KEY `fk_seat_alloc_replaces_branch`, DROP INDEX `ix_seat_alloc_replaces_branch`, DROP COLUMN `replacement_period_id`, DROP COLUMN `replacement_credit`, DROP COLUMN `replaces_branch_id`;
--   ALTER TABLE `daily_closings` DROP COLUMN `money_version`;
-- ===========================================================================

-- 1. The day's money version ------------------------------------------------------
ALTER TABLE `daily_closings`
  ADD COLUMN `money_version` INT UNSIGNED NOT NULL DEFAULT 0 AFTER `version`;

-- 2. A store request's reserved replacement slot -----------------------------------
ALTER TABLE `seat_allocations`
  ADD COLUMN `replaces_branch_id`    BINARY(16)   NULL AFTER `activity_effective`,
  ADD COLUMN `replacement_credit`    INT UNSIGNED NULL AFTER `replaces_branch_id`,
  ADD COLUMN `replacement_period_id` BINARY(16)   NULL AFTER `replacement_credit`,
  ADD INDEX `ix_seat_alloc_replaces_branch` (`replaces_branch_id`, `status`),
  ADD CONSTRAINT `fk_seat_alloc_replaces_branch` FOREIGN KEY (`replaces_branch_id`) REFERENCES `branches` (`id`);

-- 3. The replacement, linked once and for good -------------------------------------
CREATE TABLE IF NOT EXISTS `branch_replacements` (
  `id`                    BINARY(16)   NOT NULL,
  `company_id`            BINARY(16)   NOT NULL,
  `billing_period_id`     BINARY(16)   NOT NULL,
  `archived_branch_id`    BINARY(16)   NOT NULL,
  `replacement_branch_id` BINARY(16)   NOT NULL,
  `seat_allocation_id`    BINARY(16)   NOT NULL,
  `archived_activity`     ENUM('electronics','money_agent','both') NOT NULL,
  `replacement_activity`  ENUM('electronics','money_agent','both') NOT NULL,
  -- What the period had already charged for the archived location (its slot), the new store's fee at the period's
  -- prices, and what was charged for the replacement: max(0, replacement_fee - slot_fee).
  `slot_fee`              INT UNSIGNED NOT NULL,
  `replacement_fee`       INT UNSIGNED NOT NULL,
  `charged_difference`    INT UNSIGNED NOT NULL,
  `decision`              ENUM('no_additional_charge','difference_charged') NOT NULL,
  `payment_id`            BINARY(16)   NULL,
  `decided_by`            VARCHAR(160) NOT NULL,
  `decided_at`            DATETIME(6)  NOT NULL,
  `created_at`            DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_branch_replacements_slot` (`billing_period_id`, `archived_branch_id`),
  UNIQUE KEY `ux_branch_replacements_replacement` (`replacement_branch_id`),
  KEY `ix_branch_replacements_company` (`company_id`),
  KEY `ix_branch_replacements_archived` (`archived_branch_id`),
  KEY `ix_branch_replacements_request` (`seat_allocation_id`),
  CONSTRAINT `fk_branch_replacements_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_branch_replacements_period` FOREIGN KEY (`billing_period_id`) REFERENCES `billing_periods` (`id`),
  CONSTRAINT `fk_branch_replacements_archived` FOREIGN KEY (`archived_branch_id`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_branch_replacements_replacement` FOREIGN KEY (`replacement_branch_id`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_branch_replacements_request` FOREIGN KEY (`seat_allocation_id`) REFERENCES `seat_allocations` (`id`),
  CONSTRAINT `fk_branch_replacements_payment` FOREIGN KEY (`payment_id`) REFERENCES `subscription_payments` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TRIGGER IF EXISTS `branch_replacements_block_update`;
CREATE TRIGGER `branch_replacements_block_update`
BEFORE UPDATE ON `branch_replacements`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'branch_replacements is append-only: a replacement decision is never edited';
  END IF;
END;

DROP TRIGGER IF EXISTS `branch_replacements_block_delete`;
CREATE TRIGGER `branch_replacements_block_delete`
BEFORE DELETE ON `branch_replacements`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'branch_replacements is append-only: a replacement decision is never deleted';
  END IF;
END;

-- 4. Idempotency keys of the Owner's provider settings ------------------------------
CREATE TABLE IF NOT EXISTS `agent_request_keys` (
  `id`                BINARY(16)   NOT NULL,
  `company_id`        BINARY(16)   NOT NULL,
  `client_request_id` BINARY(16)   NOT NULL,
  `operation`         ENUM('provider_create','provider_update','provider_config','position_set') NOT NULL,
  `target_id`         BINARY(16)   NULL,
  `request_hash`      CHAR(64)     NOT NULL,
  `response`          JSON         NOT NULL,
  `recorded_by_id`    BINARY(16)   NOT NULL,
  `created_at`        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_agent_request_keys_key` (`company_id`, `client_request_id`),
  KEY `ix_agent_request_keys_target` (`target_id`),
  CONSTRAINT `fk_agent_request_keys_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_agent_request_keys_user` FOREIGN KEY (`recorded_by_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TRIGGER IF EXISTS `agent_request_keys_block_update`;
CREATE TRIGGER `agent_request_keys_block_update`
BEFORE UPDATE ON `agent_request_keys`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'agent_request_keys is append-only: a request key answers the same way forever';
  END IF;
END;

DROP TRIGGER IF EXISTS `agent_request_keys_block_delete`;
CREATE TRIGGER `agent_request_keys_block_delete`
BEFORE DELETE ON `agent_request_keys`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'agent_request_keys is append-only: a request key is never deleted';
  END IF;
END;
