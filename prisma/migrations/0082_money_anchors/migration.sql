-- 0082 — Money anchors: the amount a receiving account held at one moment (docs/60).
--
-- Why: Money's top card shows the money the app tracks as held in each method, carried across
-- midnight. An account's position is its latest anchor plus every movement recorded after that
-- moment. Nothing in the schema knew what an account held (rule 26a), so without this table every
-- account is unknown. The drawer is anchored by a counted, locked close, as before; this table holds
-- accounts only. Append-only: a later anchor supersedes an earlier one and the earlier one stays.
--
-- Additive: one new table, two triggers, one permission granted to every Owner role. No existing
-- row changes.

-- 1. money_anchors -------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `money_anchors` (
  `id`                    BINARY(16)    NOT NULL,
  `company_id`            BINARY(16)    NOT NULL,
  `receiving_account_id`  BINARY(16)    NOT NULL,
  `label_snapshot`        VARCHAR(80)   NOT NULL,
  `amount`                DECIMAL(14,2) NOT NULL,
  /** The server clock when the amount was recorded; never typed. */
  `at`                    DATETIME(6)   NOT NULL,
  /** The recording branch's business date at `at`, for display only. */
  `business_date`         DATE          NOT NULL,
  /** What the app tracked just before; NULL when the account was unknown. */
  `tracked_before`        DECIMAL(14,2) NULL,
  `difference`            DECIMAL(14,2) NULL,
  `note`                  VARCHAR(255)  NULL,
  `recorded_by_id`        BINARY(16)    NOT NULL,
  `recorded_at_branch_id` BINARY(16)    NOT NULL,
  `client_uuid`           BINARY(16)    NOT NULL,
  `client_request_hash`   CHAR(64)      NOT NULL,
  `created_at`            DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_money_anchors_client_uuid` (`company_id`, `client_uuid`),
  KEY `ix_money_anchors_account_at` (`company_id`, `receiving_account_id`, `at`),
  KEY `ix_money_anchors_account` (`receiving_account_id`),
  KEY `ix_money_anchors_recorded_by` (`recorded_by_id`),
  KEY `ix_money_anchors_branch` (`recorded_at_branch_id`),
  CONSTRAINT `fk_money_anchors_company`     FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_money_anchors_account`     FOREIGN KEY (`receiving_account_id`) REFERENCES `receiving_accounts` (`id`),
  CONSTRAINT `fk_money_anchors_recorded_by` FOREIGN KEY (`recorded_by_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_money_anchors_branch`      FOREIGN KEY (`recorded_at_branch_id`) REFERENCES `branches` (`id`),
  CONSTRAINT `ck_money_anchors_amount`      CHECK (`amount` >= 0),
  CONSTRAINT `ck_money_anchors_pair`        CHECK ((`tracked_before` IS NULL) = (`difference` IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Append-only for the application account, as every financial record here (0028, 0036, 0040, 0079).
DROP TRIGGER IF EXISTS `money_anchors_block_update`;
CREATE TRIGGER `money_anchors_block_update`
BEFORE UPDATE ON `money_anchors`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'money_anchors is append-only: record a new anchor instead';
  END IF;
END;

DROP TRIGGER IF EXISTS `money_anchors_block_delete`;
CREATE TRIGGER `money_anchors_block_delete`
BEFORE DELETE ON `money_anchors`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'money_anchors is append-only: an anchor is never deleted';
  END IF;
END;

-- 2. Recording an anchor is the Owner's alone (not the Administrator's, not delegated) ----------

INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'money.anchor.record', 'Record the amount an account holds'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'money.anchor.record');

INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` = 'money.anchor.record'
WHERE r.`key` = 'owner'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- Reverse SQL (not executed):
--   DELETE rp FROM `role_permissions` rp JOIN `permissions` p ON p.`id` = rp.`permission_id`
--     WHERE p.`key` = 'money.anchor.record';
--   DELETE FROM `permissions` WHERE `key` = 'money.anchor.record';
--   DROP TRIGGER IF EXISTS `money_anchors_block_update`;
--   DROP TRIGGER IF EXISTS `money_anchors_block_delete`;
--   DROP TABLE IF EXISTS `money_anchors`;
