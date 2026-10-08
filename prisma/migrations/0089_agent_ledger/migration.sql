-- ===========================================================================
-- 0089 — The Money Services Agent ledger (docs/73 §4, D154–D157, 2026-10-08).
--
-- Why: an agent branch exchanges cash for a provider's digital credit at the
-- counter. The money it holds is its drawer (the same physical cash the
-- electronics store counts) and one float per provider; what it earns is the
-- provider's commission, never the exchanged principal. Nothing in the schema
-- could hold a provider, its configuration, an exchange, the legs it moved,
-- a float's position or its count at the closing.
--
-- ## What this adds
--
-- 1. `agent_providers` — a company's providers (Bankily, Sedad, others).
-- 2. `agent_provider_configs` — each provider's configuration, VERSIONED and
--    append-only: rates in basis points (NULL = not supplied by the owner),
--    the commission destination, the principal-fee mode, the reference rule.
--    A provider posts nothing while a required field of its version in force
--    is NULL — nothing guesses a rate.
-- 3. `agent_positions` — what a provider float (or the commission a provider
--    holds) held at one moment, per branch: the anchor later figures count
--    from. Cash has no row: the drawer is anchored by the opening decision or
--    the counted close (0083, 0082's rule), exactly as for the store.
-- 4. `agent_transactions` — one customer exchange: direction, amount, the
--    customer's number (its last four apart, for masked lists), the provider
--    reference, the server-calculated commission with the configuration
--    version and snapshot it used, the business day from the server's
--    posting instant, the person derived from the session. Never edited
--    beyond its reversal fields; never deleted.
-- 5. `agent_movements` — the immutable legs every position, the drawer's
--    equation and the reports read: cash, a provider float, held commission,
--    or the outside world.
-- 6. `agent_rebalancings` — money moved between the branch's own accounts, or
--    brought in from / sent out to the outside, declared as such: never a
--    transaction, never volume, never commission.
-- 7. `agent_mistake_reports` — an employee's claim; moves nothing.
-- 8. `agent_float_counts` — each provider float counted at the daily closing,
--    expected (NULL when unknown) against counted, with a link from
--    `closing_discrepancies` so a float's difference uses the same workflow.
-- 9. Two components on the drawer's equation — `agent_in` / `agent_out` on
--    `closing_channel_counts`, `agent_cash_in` / `agent_cash_out` on
--    `daily_rollups`: the agent's cash is the drawer's cash, counted once.
--
-- Additive. Reverse, for a database you would rather not restore:
--   ALTER TABLE `closing_discrepancies` DROP FOREIGN KEY `fk_closing_discrepancies_float_count`, DROP INDEX `ix_closing_discrepancies_float_count`, DROP COLUMN `agent_float_count_id`;
--   ALTER TABLE `daily_rollups` DROP COLUMN `agent_cash_out`, DROP COLUMN `agent_cash_in`;
--   ALTER TABLE `closing_channel_counts` DROP COLUMN `agent_out`, DROP COLUMN `agent_in`;
--   DROP TABLE `agent_float_counts`, `agent_mistake_reports`, `agent_movements`, `agent_rebalancings`, `agent_transactions`, `agent_positions`, `agent_provider_configs`, `agent_providers`;
-- ===========================================================================

-- 1. Providers -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `agent_providers` (
  `id`         BINARY(16)   NOT NULL,
  `company_id` BINARY(16)   NOT NULL,
  `kind`       ENUM('bankily','sedad','other') NOT NULL,
  `label`      VARCHAR(80)  NOT NULL,
  `is_active`  TINYINT(1)   NOT NULL DEFAULT 1,
  `sort_order` INT          NOT NULL DEFAULT 0,
  `created_at` DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6)  NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_agent_providers_label` (`company_id`, `label`),
  CONSTRAINT `fk_agent_providers_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TRIGGER IF EXISTS `agent_providers_block_delete`;
CREATE TRIGGER `agent_providers_block_delete`
BEFORE DELETE ON `agent_providers`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'agent_providers: a provider is deactivated, never deleted';
  END IF;
END;

-- 2. Configuration, versioned ----------------------------------------------------
CREATE TABLE IF NOT EXISTS `agent_provider_configs` (
  `id`                        BINARY(16)    NOT NULL,
  `company_id`                BINARY(16)    NOT NULL,
  `provider_id`               BINARY(16)    NOT NULL,
  /** Basis points (100 = 1.00 %). NULL = the owner has not supplied it; the provider cannot post. */
  `rate_in_bp`                INT UNSIGNED  NULL,
  `rate_out_bp`               INT UNSIGNED  NULL,
  `same_rate_both_directions` TINYINT(1)    NOT NULL DEFAULT 1,
  `commission_destination`    ENUM('cash','provider_float','held_separately') NULL,
  `principal_fee_mode`        ENUM('separate','deducted') NULL,
  `reference_rule`            ENUM('required','optional','none') NULL,
  `effective_from`            DATETIME(6)   NOT NULL,
  `recorded_by_id`            BINARY(16)    NOT NULL,
  `recorded_by_name`          VARCHAR(160)  NOT NULL,
  `reason`                    VARCHAR(255)  NOT NULL,
  `created_at`                DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `ix_agent_provider_configs_provider`    (`provider_id`, `effective_from`),
  KEY `ix_agent_provider_configs_company`     (`company_id`),
  KEY `ix_agent_provider_configs_recorded_by` (`recorded_by_id`),
  CONSTRAINT `fk_agent_provider_configs_company`     FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_agent_provider_configs_provider`    FOREIGN KEY (`provider_id`) REFERENCES `agent_providers` (`id`),
  CONSTRAINT `fk_agent_provider_configs_recorded_by` FOREIGN KEY (`recorded_by_id`) REFERENCES `users` (`id`),
  CONSTRAINT `ck_agent_provider_configs_rates` CHECK ((`rate_in_bp` IS NULL OR `rate_in_bp` <= 10000) AND (`rate_out_bp` IS NULL OR `rate_out_bp` <= 10000))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TRIGGER IF EXISTS `agent_provider_configs_block_update`;
CREATE TRIGGER `agent_provider_configs_block_update`
BEFORE UPDATE ON `agent_provider_configs`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'agent_provider_configs is append-only: record a new version instead';
  END IF;
END;

DROP TRIGGER IF EXISTS `agent_provider_configs_block_delete`;
CREATE TRIGGER `agent_provider_configs_block_delete`
BEFORE DELETE ON `agent_provider_configs`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'agent_provider_configs is append-only: a version is never deleted';
  END IF;
END;

-- 3. Positions (anchors) ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `agent_positions` (
  `id`                  BINARY(16)    NOT NULL,
  `company_id`          BINARY(16)    NOT NULL,
  `branch_id`           BINARY(16)    NOT NULL,
  `account_kind`        ENUM('cash','provider','commission_held','external') NOT NULL,
  `provider_id`         BINARY(16)    NOT NULL,
  `amount`              DECIMAL(14,2) NOT NULL,
  /** The server clock when the amount was true; never typed. */
  `at`                  DATETIME(6)   NOT NULL,
  `business_date`       DATE          NOT NULL,
  `source`              ENUM('set','confirmed','counted_close') NOT NULL,
  `tracked_before`      DECIMAL(14,2) NULL,
  `difference`          DECIMAL(14,2) NULL,
  `note`                VARCHAR(255)  NULL,
  `recorded_by_id`      BINARY(16)    NOT NULL,
  `recorded_by_name`    VARCHAR(160)  NOT NULL,
  `client_uuid`         BINARY(16)    NOT NULL,
  `client_request_hash` CHAR(64)      NOT NULL,
  `created_at`          DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_agent_positions_client_uuid` (`company_id`, `client_uuid`),
  KEY `ix_agent_positions_account_at`  (`branch_id`, `account_kind`, `provider_id`, `at`),
  KEY `ix_agent_positions_provider`    (`provider_id`),
  KEY `ix_agent_positions_recorded_by` (`recorded_by_id`),
  CONSTRAINT `fk_agent_positions_company`     FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_agent_positions_branch`      FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_agent_positions_provider`    FOREIGN KEY (`provider_id`) REFERENCES `agent_providers` (`id`),
  CONSTRAINT `fk_agent_positions_recorded_by` FOREIGN KEY (`recorded_by_id`) REFERENCES `users` (`id`),
  CONSTRAINT `ck_agent_positions_amount`  CHECK (`amount` >= 0),
  CONSTRAINT `ck_agent_positions_account` CHECK (`account_kind` IN ('provider','commission_held')),
  CONSTRAINT `ck_agent_positions_pair`    CHECK ((`tracked_before` IS NULL) = (`difference` IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TRIGGER IF EXISTS `agent_positions_block_update`;
CREATE TRIGGER `agent_positions_block_update`
BEFORE UPDATE ON `agent_positions`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'agent_positions is append-only: record a new position instead';
  END IF;
END;

DROP TRIGGER IF EXISTS `agent_positions_block_delete`;
CREATE TRIGGER `agent_positions_block_delete`
BEFORE DELETE ON `agent_positions`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'agent_positions is append-only: a position is never deleted';
  END IF;
END;

-- 4. Transactions --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `agent_transactions` (
  `id`                    BINARY(16)    NOT NULL,
  `company_id`            BINARY(16)    NOT NULL,
  `branch_id`             BINARY(16)    NOT NULL,
  `provider_id`           BINARY(16)    NOT NULL,
  `direction`             ENUM('cash_in_credit_out','cash_out_credit_in') NOT NULL,
  `amount`                DECIMAL(14,2) NOT NULL,
  /** Normalized digits with an optional leading +; read in full only under agent.customer.reveal. */
  `customer_number`       VARCHAR(40)   NOT NULL,
  `customer_number_last4` CHAR(4)       NOT NULL,
  `provider_reference`    VARCHAR(120)  NULL,
  `commission_amount`     DECIMAL(14,2) NOT NULL,
  `commission_rate_bp`    INT UNSIGNED  NOT NULL,
  `config_version_id`     BINARY(16)    NOT NULL,
  `config_snapshot`       JSON          NOT NULL,
  `business_date`         DATE          NOT NULL,
  /** The server clock at posting; the business day is assigned from it (D155). */
  `recorded_at`           DATETIME(6)   NOT NULL,
  `device_recorded_at`    DATETIME(6)   NULL,
  `recorded_by_id`        BINARY(16)    NOT NULL,
  `recorded_by_name`      VARCHAR(160)  NOT NULL,
  `client_uuid`           BINARY(16)    NOT NULL,
  `client_request_hash`   CHAR(64)      NOT NULL,
  `status`                ENUM('completed','reversed') NOT NULL DEFAULT 'completed',
  `reversed_by_id`        BINARY(16)    NULL,
  `reversed_by_name`      VARCHAR(160)  NULL,
  `reversed_at`           DATETIME(6)   NULL,
  `reversal_reason`       VARCHAR(255)  NULL,
  `reversal_client_uuid`  BINARY(16)    NULL,
  `created_at`            DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_agent_transactions_client_uuid` (`company_id`, `client_uuid`),
  KEY `ix_agent_transactions_branch_day`  (`branch_id`, `business_date`, `recorded_at`),
  KEY `ix_agent_transactions_provider`    (`provider_id`),
  KEY `ix_agent_transactions_config`      (`config_version_id`),
  KEY `ix_agent_transactions_last4`       (`company_id`, `customer_number_last4`),
  KEY `ix_agent_transactions_recorded_by` (`recorded_by_id`),
  KEY `ix_agent_transactions_reversed_by` (`reversed_by_id`),
  CONSTRAINT `fk_agent_transactions_company`     FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_agent_transactions_branch`      FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_agent_transactions_provider`    FOREIGN KEY (`provider_id`) REFERENCES `agent_providers` (`id`),
  CONSTRAINT `fk_agent_transactions_config`      FOREIGN KEY (`config_version_id`) REFERENCES `agent_provider_configs` (`id`),
  CONSTRAINT `fk_agent_transactions_recorded_by` FOREIGN KEY (`recorded_by_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_agent_transactions_reversed_by` FOREIGN KEY (`reversed_by_id`) REFERENCES `users` (`id`),
  CONSTRAINT `ck_agent_transactions_amount`     CHECK (`amount` > 0),
  CONSTRAINT `ck_agent_transactions_commission` CHECK (`commission_amount` >= 0 AND `commission_rate_bp` <= 10000),
  CONSTRAINT `ck_agent_transactions_reversal`   CHECK ((`status` = 'reversed') = (`reversed_at` IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- A completed exchange is never rewritten: only its reversal fields may be set, once.
DROP TRIGGER IF EXISTS `agent_transactions_block_update`;
CREATE TRIGGER `agent_transactions_block_update`
BEFORE UPDATE ON `agent_transactions`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    IF NEW.`amount` <> OLD.`amount` OR NEW.`direction` <> OLD.`direction` OR NEW.`provider_id` <> OLD.`provider_id`
       OR NEW.`commission_amount` <> OLD.`commission_amount` OR NEW.`commission_rate_bp` <> OLD.`commission_rate_bp`
       OR NEW.`config_version_id` <> OLD.`config_version_id` OR NEW.`business_date` <> OLD.`business_date`
       OR NEW.`recorded_at` <> OLD.`recorded_at` OR NEW.`recorded_by_id` <> OLD.`recorded_by_id`
       OR NEW.`client_uuid` <> OLD.`client_uuid` OR NEW.`branch_id` <> OLD.`branch_id` OR NEW.`company_id` <> OLD.`company_id`
       OR NEW.`customer_number` <> OLD.`customer_number` THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'agent_transactions: a completed exchange is never edited — reverse it';
    END IF;
    IF OLD.`status` = 'reversed' THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'agent_transactions: a reversed exchange is final';
    END IF;
  END IF;
END;

DROP TRIGGER IF EXISTS `agent_transactions_block_delete`;
CREATE TRIGGER `agent_transactions_block_delete`
BEFORE DELETE ON `agent_transactions`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'agent_transactions: an exchange is never deleted — reverse it';
  END IF;
END;

-- 5. Rebalancings (before the legs that reference them) ---------------------------
CREATE TABLE IF NOT EXISTS `agent_rebalancings` (
  `id`                    BINARY(16)    NOT NULL,
  `company_id`            BINARY(16)    NOT NULL,
  `branch_id`             BINARY(16)    NOT NULL,
  `reason`                VARCHAR(255)  NOT NULL,
  `note`                  VARCHAR(500)  NULL,
  `external_counterparty` ENUM('owner_capital','provider_settlement','other') NULL,
  /** Signed: positive when money came in from outside, negative when it went out; NULL when the legs net to zero. */
  `external_amount`       DECIMAL(14,2) NULL,
  `business_date`         DATE          NOT NULL,
  `recorded_at`           DATETIME(6)   NOT NULL,
  `recorded_by_id`        BINARY(16)    NOT NULL,
  `recorded_by_name`      VARCHAR(160)  NOT NULL,
  `client_uuid`           BINARY(16)    NOT NULL,
  `client_request_hash`   CHAR(64)      NOT NULL,
  `created_at`            DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_agent_rebalancings_client_uuid` (`company_id`, `client_uuid`),
  KEY `ix_agent_rebalancings_branch_day`  (`branch_id`, `business_date`),
  KEY `ix_agent_rebalancings_recorded_by` (`recorded_by_id`),
  CONSTRAINT `fk_agent_rebalancings_company`     FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_agent_rebalancings_branch`      FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_agent_rebalancings_recorded_by` FOREIGN KEY (`recorded_by_id`) REFERENCES `users` (`id`),
  CONSTRAINT `ck_agent_rebalancings_external` CHECK ((`external_counterparty` IS NULL) = (`external_amount` IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TRIGGER IF EXISTS `agent_rebalancings_block_update`;
CREATE TRIGGER `agent_rebalancings_block_update`
BEFORE UPDATE ON `agent_rebalancings`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'agent_rebalancings is append-only: record a counter-movement instead';
  END IF;
END;

DROP TRIGGER IF EXISTS `agent_rebalancings_block_delete`;
CREATE TRIGGER `agent_rebalancings_block_delete`
BEFORE DELETE ON `agent_rebalancings`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'agent_rebalancings is append-only: a rebalancing is never deleted';
  END IF;
END;

-- 6. Movements — the immutable legs ---------------------------------------------
CREATE TABLE IF NOT EXISTS `agent_movements` (
  `id`             BINARY(16)    NOT NULL,
  `company_id`     BINARY(16)    NOT NULL,
  `branch_id`      BINARY(16)    NOT NULL,
  `account_kind`   ENUM('cash','provider','commission_held','external') NOT NULL,
  `provider_id`    BINARY(16)    NULL,
  `direction`      ENUM('inflow','outflow') NOT NULL,
  `amount`         DECIMAL(14,2) NOT NULL,
  `kind`           ENUM('principal','commission','reversal','rebalancing') NOT NULL,
  `transaction_id` BINARY(16)    NULL,
  `rebalancing_id` BINARY(16)    NULL,
  `business_date`  DATE          NOT NULL,
  `recorded_at`    DATETIME(6)   NOT NULL,
  `created_at`     DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `ix_agent_movements_branch_day`  (`branch_id`, `business_date`),
  KEY `ix_agent_movements_account_at`  (`branch_id`, `account_kind`, `provider_id`, `recorded_at`),
  KEY `ix_agent_movements_company`     (`company_id`),
  KEY `ix_agent_movements_provider`    (`provider_id`),
  KEY `ix_agent_movements_transaction` (`transaction_id`),
  KEY `ix_agent_movements_rebalancing` (`rebalancing_id`),
  CONSTRAINT `fk_agent_movements_company`     FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_agent_movements_branch`      FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_agent_movements_provider`    FOREIGN KEY (`provider_id`) REFERENCES `agent_providers` (`id`),
  CONSTRAINT `fk_agent_movements_transaction` FOREIGN KEY (`transaction_id`) REFERENCES `agent_transactions` (`id`),
  CONSTRAINT `fk_agent_movements_rebalancing` FOREIGN KEY (`rebalancing_id`) REFERENCES `agent_rebalancings` (`id`),
  CONSTRAINT `ck_agent_movements_amount`   CHECK (`amount` > 0),
  CONSTRAINT `ck_agent_movements_provider` CHECK ((`account_kind` IN ('cash','external') AND `provider_id` IS NULL) OR (`account_kind` IN ('provider','commission_held') AND `provider_id` IS NOT NULL)),
  CONSTRAINT `ck_agent_movements_source`   CHECK ((`transaction_id` IS NULL) <> (`rebalancing_id` IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TRIGGER IF EXISTS `agent_movements_block_update`;
CREATE TRIGGER `agent_movements_block_update`
BEFORE UPDATE ON `agent_movements`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'agent_movements is append-only: a leg is countered, never changed';
  END IF;
END;

DROP TRIGGER IF EXISTS `agent_movements_block_delete`;
CREATE TRIGGER `agent_movements_block_delete`
BEFORE DELETE ON `agent_movements`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'agent_movements is append-only: a leg is never deleted';
  END IF;
END;

-- 7. Mistake reports ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `agent_mistake_reports` (
  `id`                  BINARY(16)   NOT NULL,
  `company_id`          BINARY(16)   NOT NULL,
  `branch_id`           BINARY(16)   NOT NULL,
  `transaction_id`      BINARY(16)   NOT NULL,
  `kind`                ENUM('wrong_amount','wrong_direction','wrong_provider','wrong_number','wrong_reference','other') NOT NULL,
  `note`                VARCHAR(500) NULL,
  `status`              ENUM('open','reversed','dismissed') NOT NULL DEFAULT 'open',
  `reported_by_id`      BINARY(16)   NOT NULL,
  `reported_by_name`    VARCHAR(160) NOT NULL,
  `reported_at`         DATETIME(6)  NOT NULL,
  `decided_by_id`       BINARY(16)   NULL,
  `decided_by_name`     VARCHAR(160) NULL,
  `decided_at`          DATETIME(6)  NULL,
  `decision_note`       VARCHAR(255) NULL,
  `client_uuid`         BINARY(16)   NOT NULL,
  `client_request_hash` CHAR(64)     NOT NULL,
  `created_at`          DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_agent_mistake_reports_client_uuid` (`company_id`, `client_uuid`),
  KEY `ix_agent_mistake_reports_transaction`   (`transaction_id`),
  KEY `ix_agent_mistake_reports_branch_status` (`branch_id`, `status`),
  KEY `ix_agent_mistake_reports_reported_by`   (`reported_by_id`),
  KEY `ix_agent_mistake_reports_decided_by`    (`decided_by_id`),
  CONSTRAINT `fk_agent_mistake_reports_company`     FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_agent_mistake_reports_branch`      FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_agent_mistake_reports_transaction` FOREIGN KEY (`transaction_id`) REFERENCES `agent_transactions` (`id`),
  CONSTRAINT `fk_agent_mistake_reports_reported_by` FOREIGN KEY (`reported_by_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_agent_mistake_reports_decided_by`  FOREIGN KEY (`decided_by_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TRIGGER IF EXISTS `agent_mistake_reports_block_delete`;
CREATE TRIGGER `agent_mistake_reports_block_delete`
BEFORE DELETE ON `agent_mistake_reports`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'agent_mistake_reports: a report is decided, never deleted';
  END IF;
END;

-- 8. Float counts at the closing ------------------------------------------------
CREATE TABLE IF NOT EXISTS `agent_float_counts` (
  `id`            BINARY(16)    NOT NULL,
  `company_id`    BINARY(16)    NOT NULL,
  `closing_id`    BINARY(16)    NOT NULL,
  `branch_id`     BINARY(16)    NOT NULL,
  `provider_id`   BINARY(16)    NOT NULL,
  /** NULL when the float's position is unknown: nothing to compare, and nothing fabricated. */
  `expected`      DECIMAL(14,2) NULL,
  `counted`       DECIMAL(14,2) NULL,
  `difference`    DECIMAL(14,2) NULL,
  `explanation`   VARCHAR(255)  NULL,
  `is_skipped`    TINYINT(1)    NOT NULL DEFAULT 0,
  `skip_reason`   VARCHAR(255)  NULL,
  `counted_by_id` BINARY(16)    NULL,
  `counted_at`    DATETIME(6)   NULL,
  `created_at`    DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`    DATETIME(6)   NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_agent_float_counts_closing_provider` (`closing_id`, `provider_id`),
  KEY `ix_agent_float_counts_company`    (`company_id`),
  KEY `ix_agent_float_counts_branch`     (`branch_id`),
  KEY `ix_agent_float_counts_provider`   (`provider_id`),
  KEY `ix_agent_float_counts_counted_by` (`counted_by_id`),
  CONSTRAINT `fk_agent_float_counts_company`    FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_agent_float_counts_closing`    FOREIGN KEY (`closing_id`) REFERENCES `daily_closings` (`id`),
  CONSTRAINT `fk_agent_float_counts_branch`     FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_agent_float_counts_provider`   FOREIGN KEY (`provider_id`) REFERENCES `agent_providers` (`id`),
  CONSTRAINT `fk_agent_float_counts_counted_by` FOREIGN KEY (`counted_by_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `closing_discrepancies`
  ADD COLUMN `agent_float_count_id` BINARY(16) NULL AFTER `channel_count_id`,
  ADD KEY `ix_closing_discrepancies_float_count` (`agent_float_count_id`),
  ADD CONSTRAINT `fk_closing_discrepancies_float_count` FOREIGN KEY (`agent_float_count_id`) REFERENCES `agent_float_counts` (`id`);

-- 9. The agent's cash is the drawer's cash: two more components of its equation ----
ALTER TABLE `closing_channel_counts`
  ADD COLUMN `agent_in`  DECIMAL(14,2) NOT NULL DEFAULT 0.00 AFTER `corrections_out`,
  ADD COLUMN `agent_out` DECIMAL(14,2) NOT NULL DEFAULT 0.00 AFTER `agent_in`;

ALTER TABLE `daily_rollups`
  ADD COLUMN `agent_cash_in`  DECIMAL(14,2) NOT NULL DEFAULT 0.00 AFTER `corrections_cash`,
  ADD COLUMN `agent_cash_out` DECIMAL(14,2) NOT NULL DEFAULT 0.00 AFTER `agent_cash_in`;
