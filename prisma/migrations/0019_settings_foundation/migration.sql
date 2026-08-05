-- 0019 — Settings foundation (docs/21 step 3).
--
-- Additive only: two new tables, one backfill, and the removal of one
-- superseded seed row. Nothing existing is altered or dropped.
--
-- Written by hand rather than generated. `prisma migrate diff` also proposes
-- dropping the raw-SQL objects created in 0002 (the products fulltext index,
-- the settings `branch_scope` generated column, the functional unique indexes
-- on units and sale_items) because the Prisma schema cannot describe them. Those
-- proposals are drift artifacts, not intent, and applying them would silently
-- remove live constraints.
--
-- Every statement is guarded so a rerun changes nothing.

-- Owner-configured business policy: exactly one row per company.
CREATE TABLE IF NOT EXISTS `company_settings` (
  `company_id`               BINARY(16)     NOT NULL,
  -- 0 = the shop does not accept returns. Otherwise the window in hours.
  `return_window_hours`      INTEGER        NOT NULL DEFAULT 0,
  `whatsapp_language`        ENUM('en','ar') NOT NULL DEFAULT 'en',
  `whatsapp_include_amounts` BOOLEAN        NOT NULL DEFAULT false,
  `whatsapp_daily_enabled`   BOOLEAN        NOT NULL DEFAULT false,
  `whatsapp_monthly_enabled` BOOLEAN        NOT NULL DEFAULT false,
  -- Seconds. 0 locks immediately; there is no value meaning "never".
  `auto_lock_max_seconds`    INTEGER        NOT NULL DEFAULT 300,
  `version`                  INTEGER        NOT NULL DEFAULT 0,
  `updated_at`               DATETIME(6)    NOT NULL,
  `updated_by`               BINARY(16)     NULL,

  PRIMARY KEY (`company_id`),
  CONSTRAINT `company_settings_company_id_fkey`
    FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Shop accounts customers may send money to. Deliberately no credential,
-- secret or balance columns: the app records where money is expected, it does
-- not authenticate to any provider and does not process payments.
CREATE TABLE IF NOT EXISTS `receiving_accounts` (
  `id`            BINARY(16)  NOT NULL,
  `company_id`    BINARY(16)  NOT NULL,
  `provider`      ENUM('bankily','sedad','bim_bank','other') NOT NULL,
  `provider_name` VARCHAR(60) NULL,
  `label`         VARCHAR(80) NOT NULL,
  `is_active`     BOOLEAN     NOT NULL DEFAULT true,
  `sort_order`    INTEGER     NOT NULL DEFAULT 0,
  `version`       INTEGER     NOT NULL DEFAULT 0,
  `created_at`    DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`    DATETIME(6) NOT NULL,
  `created_by`    BINARY(16)  NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `receiving_accounts_company_id_label_key` (`company_id`, `label`),
  INDEX `receiving_accounts_company_id_is_active_sort_order_idx` (`company_id`, `is_active`, `sort_order`),
  CONSTRAINT `receiving_accounts_company_id_fkey`
    FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Safe defaults for every company that already exists. A missing row would
-- make `GET /settings` a 404 for a shop that has done nothing wrong, so the
-- row is created up front rather than lazily.
--
-- `return_window_hours` defaults to 0 (no returns). Returns are currently
-- unconditional because no window check exists anywhere yet; defaulting to a
-- window nobody chose would hand out a refund period the Owner never agreed
-- to, and money leaving the till is the harder mistake to undo. The Owner opts
-- in explicitly.
INSERT INTO `company_settings` (`company_id`, `updated_at`)
SELECT c.`id`, NOW(6)
FROM `companies` c
WHERE NOT EXISTS (
  SELECT 1 FROM `company_settings` cs WHERE cs.`company_id` = c.`id`
);

-- The seeded `whatsapp_schedule` key is superseded by the typed columns above.
-- It was written by the seed and read by nothing (no consumer exists in the
-- codebase). Leaving it would give "is the WhatsApp summary on?" two answers,
-- which is exactly the duplicate concept this migration exists to avoid.
DELETE FROM `settings` WHERE `key` = 'whatsapp_schedule';
