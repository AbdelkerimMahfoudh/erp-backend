-- Milestone K — subscription entitlement.
--
-- One functional product plan. No feature tiers, and no feature flags scattered
-- through business services: a shop either has a live subscription or it does
-- not, and the only thing that changes is whether the server accepts writes.
--
-- The billing unit is a BRANCH, but entitlement and seat capacity are evaluated
-- across the COMPANY — included seats pool freely, because a shop that hires a
-- second person at its quieter branch has not changed what it owes.

CREATE TABLE `subscriptions` (
  `id`                      BINARY(16)   NOT NULL,
  `company_id`              BINARY(16)   NOT NULL,

  -- Branches the company is paying for. Included seats derive from this.
  `subscribed_branch_count` INT UNSIGNED NOT NULL DEFAULT 1,
  -- Bought beyond the included pool. Not prorated.
  `additional_seats`        INT UNSIGNED NOT NULL DEFAULT 0,

  -- When the paid period ends. Grace is derived as +72h, never stored, so it
  -- cannot drift away from the period it belongs to.
  `current_period_end`      DATETIME(6)  NULL,

  -- Granted by the platform, never by a tenant. Recorded with who and why.
  `is_complimentary`        TINYINT(1)   NOT NULL DEFAULT 0,
  `complimentary_reason`    VARCHAR(255) NULL,
  `complimentary_until`     DATETIME(6)  NULL,

  `created_at`              DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`              DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `version`                 INT UNSIGNED NOT NULL DEFAULT 0,

  PRIMARY KEY (`id`),
  -- One per company. Two subscription rows would make "is this shop paid up?"
  -- a question with two answers.
  UNIQUE KEY `ux_subscriptions_company` (`company_id`),
  CONSTRAINT `fk_subscriptions_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  -- A complimentary grant that never ends is indistinguishable from a mistake.
  CONSTRAINT `ck_subscriptions_complimentary`
    CHECK (`is_complimentary` = 0 OR (`complimentary_reason` IS NOT NULL AND `complimentary_until` IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every change to what a company is entitled to, kept forever.
--
-- Append-only and enforced below: a subscription record that can be quietly
-- rewritten is worth nothing as evidence, and "who gave this shop free access
-- and when" is exactly the question somebody will eventually ask.
CREATE TABLE `subscription_events` (
  `id`               BINARY(16)   NOT NULL,
  `company_id`       BINARY(16)   NOT NULL,
  `subscription_id`  BINARY(16)   NOT NULL,
  `kind`             ENUM('created','extended','branches_changed','seats_changed','complimentary_granted','complimentary_revoked','backfilled') NOT NULL,
  -- Free text from the operator. Never shown to the tenant.
  `note`             VARCHAR(255) NULL,
  `period_end_after` DATETIME(6)  NULL,
  `branches_after`   INT UNSIGNED NULL,
  `seats_after`      INT UNSIGNED NULL,
  -- Who did it. NULL means the migration itself, which only backfill uses.
  `actor`            VARCHAR(120) NULL,
  `created_at`       DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  PRIMARY KEY (`id`),
  KEY `ix_subevents_company` (`company_id`, `created_at`),
  CONSTRAINT `fk_subevents_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_subevents_subscription` FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only, by the same pattern as `audit_logs` and the money ledgers: the
-- application user may insert and nothing else. The migrator is exempt so a
-- restore can rebuild the table.

CREATE TRIGGER `trg_subevents_no_update` BEFORE UPDATE ON `subscription_events`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'subscription_events is append-only';
  END IF;
END;

CREATE TRIGGER `trg_subevents_no_delete` BEFORE DELETE ON `subscription_events`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'subscription_events is append-only';
  END IF;
END;


-- Backfill.
--
-- Every existing company gets a live subscription covering its current branches,
-- ending a year out. Deploying this migration must NOT lock the demo tenant or
-- anybody already using the product: a shop discovering at 8am that yesterday's
-- upgrade turned its till read-only would be the worst possible introduction to
-- a billing feature.
INSERT INTO `subscriptions` (`id`, `company_id`, `subscribed_branch_count`, `additional_seats`, `current_period_end`)
SELECT
  UNHEX(REPLACE(UUID(), '-', '')),
  c.`id`,
  GREATEST(1, (SELECT COUNT(*) FROM `branches` b WHERE b.`company_id` = c.`id`)),
  0,
  DATE_ADD(NOW(6), INTERVAL 1 YEAR)
FROM `companies` c
WHERE NOT EXISTS (SELECT 1 FROM `subscriptions` s WHERE s.`company_id` = c.`id`);

INSERT INTO `subscription_events` (`id`, `company_id`, `subscription_id`, `kind`, `note`, `period_end_after`, `branches_after`, `seats_after`, `actor`)
SELECT
  UNHEX(REPLACE(UUID(), '-', '')),
  s.`company_id`,
  s.`id`,
  'backfilled',
  'Existing tenant at K deployment; one year granted so nobody is locked out by the upgrade',
  s.`current_period_end`,
  s.`subscribed_branch_count`,
  s.`additional_seats`,
  NULL
FROM `subscriptions` s;
