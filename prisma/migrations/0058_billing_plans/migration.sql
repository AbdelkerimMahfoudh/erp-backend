-- Pricing: a dated plan version, and an immutable snapshot per billing period.
--
-- Integer MRU throughout. No float touches an amount anywhere in this feature:
-- a price that is 1000 in one place and 999.9999999 in another is not a
-- rounding problem, it is an argument with a shopkeeper, and the shopkeeper is
-- right.

CREATE TABLE `plan_versions` (
  `id`                        BINARY(16)   NOT NULL,
  `plan_key`                  VARCHAR(40)  NOT NULL DEFAULT 'standard',
  `version`                   INT UNSIGNED NOT NULL,
  `branch_monthly`            INT UNSIGNED NOT NULL,
  `included_staff_per_branch` INT UNSIGNED NOT NULL,
  `extra_staff_monthly`       INT UNSIGNED NOT NULL,
  `effective_from`            DATETIME(6)  NOT NULL,
  `created_by`                VARCHAR(160) NOT NULL,
  `reason`                    VARCHAR(500) NOT NULL,
  `created_at`                DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_plan_versions_key_version` (`plan_key`, `version`),
  KEY `ix_plan_versions_effective` (`plan_key`, `effective_from`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The unit prices are COPIED into every period rather than joined at read time.
-- A join would mean the figure a shop saw in March changes the day somebody
-- schedules a new price — exactly what an immutable snapshot exists to prevent.
CREATE TABLE `billing_periods` (
  `id`                        BINARY(16)   NOT NULL,
  `company_id`                BINARY(16)   NOT NULL,
  `subscription_id`           BINARY(16)   NOT NULL,
  `plan_version_id`           BINARY(16)   NOT NULL,
  `period_start`              DATETIME(6)  NOT NULL,
  `period_end`                DATETIME(6)  NULL,
  `branch_monthly`            INT UNSIGNED NOT NULL,
  `included_staff_per_branch` INT UNSIGNED NOT NULL,
  `extra_staff_monthly`       INT UNSIGNED NOT NULL,
  `active_branch_count`       INT UNSIGNED NOT NULL,
  `active_staff_count`        INT UNSIGNED NOT NULL,
  `included_staff_count`      INT UNSIGNED NOT NULL,
  `chargeable_staff_count`    INT UNSIGNED NOT NULL,
  `assessed_branch_fee`       INT UNSIGNED NOT NULL,
  `assessed_staff_fee`        INT UNSIGNED NOT NULL,
  `assessed_total`            INT UNSIGNED NOT NULL,
  `currency`                  CHAR(3)      NOT NULL DEFAULT 'MRU',
  `created_at`                DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`                DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `ix_billing_periods_company` (`company_id`, `period_start`),
  CONSTRAINT `fk_billing_periods_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_billing_periods_subscription` FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions` (`id`),
  CONSTRAINT `fk_billing_periods_plan` FOREIGN KEY (`plan_version_id`) REFERENCES `plan_versions` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The launch price, as approved. Effective from the epoch so every existing
-- company can be quoted immediately without inventing a history for them.
INSERT INTO `plan_versions`
  (`id`, `plan_key`, `version`, `branch_monthly`, `included_staff_per_branch`,
   `extra_staff_monthly`, `effective_from`, `created_by`, `reason`)
VALUES
  (UNHEX('00000000000000000000000000000001'), 'standard', 1, 500, 2, 100,
   '2020-01-01 00:00:00.000000', 'migration',
   'Approved launch pricing: 500 MRU per active branch, two staff included per branch pooled company-wide, 100 MRU per additional active staff account.');
