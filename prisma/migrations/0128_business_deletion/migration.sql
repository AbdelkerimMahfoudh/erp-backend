-- Post-Build-4 (owner, 2026-11-03): an administrator's staged deletion of a business. One row per business, written
-- when it is prepared (subscription cancelled, business deactivated, sessions revoked) and completed once, by the final
-- deletion: who, when, and which retention policy was applied. Permanent: never deleted, its history never rewritten.
-- `companies.deleted_at` marks every retained, de-identified record as belonging to a deleted business.
-- Additive. Reverse (only while no row exists): DROP TABLE business_deletions; ALTER TABLE companies DROP COLUMN deleted_at.
ALTER TABLE `companies` ADD COLUMN `deleted_at` DATETIME(6) NULL;

CREATE TABLE `business_deletions` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `stage` VARCHAR(16) NOT NULL,
  `prepared_at` DATETIME(6) NOT NULL,
  `prepared_by_admin_id` BINARY(16) NOT NULL,
  `prepared_by` VARCHAR(160) NOT NULL,
  `completed_at` DATETIME(6) NULL,
  `completed_by_admin_id` BINARY(16) NULL,
  `completed_by` VARCHAR(160) NULL,
  `retention_policy` VARCHAR(40) NULL,
  `summary` JSON NULL,
  `version` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_business_deletions_company` (`company_id`),
  CONSTRAINT `fk_business_deletions_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `ck_business_deletions_stage` CHECK (`stage` IN ('prepared', 'completed')),
  CONSTRAINT `ck_business_deletions_completed` CHECK (
    (`stage` = 'prepared' AND `completed_at` IS NULL AND `completed_by_admin_id` IS NULL AND `completed_by` IS NULL AND `retention_policy` IS NULL)
    OR (`stage` = 'completed' AND `completed_at` IS NOT NULL AND `completed_by_admin_id` IS NOT NULL AND `completed_by` IS NOT NULL AND `retention_policy` IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TRIGGER IF EXISTS `trg_business_deletion_update`;
CREATE TRIGGER `trg_business_deletion_update`
BEFORE UPDATE ON `business_deletions`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    IF NOT (NEW.`id` <=> OLD.`id`) OR NOT (NEW.`company_id` <=> OLD.`company_id`)
       OR NOT (NEW.`prepared_at` <=> OLD.`prepared_at`) OR NOT (NEW.`prepared_by_admin_id` <=> OLD.`prepared_by_admin_id`)
       OR NOT (NEW.`prepared_by` <=> OLD.`prepared_by`) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'business_deletions: who prepared a deletion, and when, never changes';
    END IF;
    IF OLD.`stage` = 'completed' THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'business_deletions: a completed deletion is final';
    END IF;
  END IF;
END;

DROP TRIGGER IF EXISTS `trg_business_deletion_no_delete`;
CREATE TRIGGER `trg_business_deletion_no_delete`
BEFORE DELETE ON `business_deletions`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'business_deletions: a deletion record is permanent';
  END IF;
END;
