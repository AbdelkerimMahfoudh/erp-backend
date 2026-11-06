-- 0132: per-branch entitlements (owner's brief, 2026-11-06; docs/122). Additive: three tables, one nullable column.
--
-- Each store branch carries its own timeline: a trial end (the business's first branch only), a paid end, a
-- complimentary grant. Its state is computed from these and the business's suspension (entitlement/branch-rules.ts).
--   * branch_entitlements      one row per opened store branch;
--   * branch_periods           its history, one row per trial / paid period / grant / grandfathered start; a payment
--                              or proof extends a branch once (unique keys);
--   * branch_grace_episodes    the grace decision per branch period end (72 h, 3 in any rolling 12 months, per branch);
--   * payment_proofs.lines     the quote's lines at submission, applied exactly at approval.
--
-- Grandfathering (docs/122 §7): every existing store branch receives its business's current timeline, so nothing that
-- can write today stops writing. A business never activated (no period, no trial, no grant) gets no row: locked, as
-- inaccessible as before. Rollback: BRANCH_ENTITLEMENTS=off; the tables can stay (nothing older reads them).

CREATE TABLE `branch_entitlements` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `branch_id` BINARY(16) NOT NULL,
  `trial_ends_at` DATETIME(6) NULL,
  `paid_until` DATETIME(6) NULL,
  `complimentary` BOOLEAN NOT NULL DEFAULT FALSE,
  `complimentary_until` DATETIME(6) NULL,
  `version` INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_branch_entitlement_branch` (`branch_id`),
  KEY `ix_branch_entitlement_company` (`company_id`),
  KEY `ix_branch_entitlement_paid_until` (`paid_until`),
  CONSTRAINT `fk_branch_entitlement_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_branch_entitlement_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `branch_periods` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `branch_id` BINARY(16) NOT NULL,
  `source` ENUM('trial','payment','grant','grandfathered','admin') NOT NULL,
  `months` TINYINT UNSIGNED NULL,
  `starts_at` DATETIME(6) NOT NULL,
  `ends_at` DATETIME(6) NULL,
  `amount` INT UNSIGNED NULL,
  `payment_id` BINARY(16) NULL,
  `payment_proof_id` BINARY(16) NULL,
  `recorded_by` VARCHAR(160) NOT NULL,
  `note` VARCHAR(255) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_branch_period_proof` (`payment_proof_id`, `branch_id`),
  UNIQUE KEY `ux_branch_period_payment` (`payment_id`, `branch_id`),
  KEY `ix_branch_period_branch` (`branch_id`, `starts_at`),
  KEY `ix_branch_period_company` (`company_id`, `created_at`),
  CONSTRAINT `fk_branch_period_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_branch_period_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`),
  CONSTRAINT `ck_branch_period_span` CHECK (`ends_at` IS NULL OR `ends_at` > `starts_at`),
  CONSTRAINT `ck_branch_period_months` CHECK (`months` IS NULL OR `months` IN (1, 3, 12) OR `source` IN ('grandfathered','admin','grant'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `branch_grace_episodes` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `branch_id` BINARY(16) NOT NULL,
  `period_end` DATETIME(6) NOT NULL,
  `decision` ENUM('granted','refused') NOT NULL,
  `started_at` DATETIME(6) NOT NULL,
  `ends_at` DATETIME(6) NOT NULL,
  `uses_before` TINYINT UNSIGNED NOT NULL,
  `recorded_at` DATETIME(6) NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_branch_grace_period` (`branch_id`, `period_end`),
  KEY `ix_branch_grace_window` (`branch_id`, `decision`, `started_at`),
  CONSTRAINT `fk_branch_grace_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_branch_grace_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `payment_proofs` ADD COLUMN `lines` JSON NULL;

-- Grandfathering: each existing, undeleted store branch of a business that has a timeline.
-- The business's first store (oldest, then lowest id) takes its trial; any other existing store keeps the same dates
-- (never locked by this change). A paid end and a complimentary grant are copied to every store.
INSERT INTO `branch_entitlements` (`id`, `company_id`, `branch_id`, `trial_ends_at`, `paid_until`, `complimentary`, `complimentary_until`)
SELECT UUID_TO_BIN(UUID(), 1), b.company_id, b.id,
       tc.ends_at,
       s.current_period_end,
       s.is_complimentary = 1,
       IF(s.is_complimentary = 1, s.complimentary_until, NULL)
FROM `branches` b
JOIN `subscriptions` s ON s.company_id = b.company_id
LEFT JOIN `trial_claims` tc ON tc.company_id = b.company_id
WHERE b.type = 'store' AND b.deleted_at IS NULL
  AND (s.current_period_end IS NOT NULL OR s.is_complimentary = 1 OR tc.id IS NOT NULL);

INSERT INTO `branch_periods` (`id`, `company_id`, `branch_id`, `source`, `starts_at`, `ends_at`, `recorded_by`, `note`)
SELECT UUID_TO_BIN(UUID(), 1), e.company_id, e.branch_id, 'grandfathered',
       LEAST(b.created_at, COALESCE(e.trial_ends_at, e.paid_until, e.complimentary_until, b.created_at) - INTERVAL 1 SECOND),
       COALESCE(GREATEST(COALESCE(e.paid_until, e.trial_ends_at), COALESCE(e.trial_ends_at, e.paid_until)), e.complimentary_until),
       'migration:0132', 'The business''s timeline at the change to per-branch entitlements (docs/122 §7).'
FROM `branch_entitlements` e JOIN `branches` b ON b.id = e.branch_id;

-- The grace decision already recorded for a business's current period end is that end's decision on each store.
INSERT INTO `branch_grace_episodes` (`id`, `company_id`, `branch_id`, `period_end`, `decision`, `started_at`, `ends_at`, `uses_before`, `recorded_at`)
SELECT UUID_TO_BIN(UUID(), 1), g.company_id, e.branch_id, g.period_end, g.decision, g.started_at, g.ends_at, g.uses_before, g.recorded_at
FROM `grace_episodes` g
JOIN `branch_entitlements` e ON e.company_id = g.company_id
WHERE g.started_at >= NOW(6) - INTERVAL 12 MONTH;
