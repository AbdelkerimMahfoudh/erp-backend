-- ===========================================================================
-- 0004_branch_counters — atomic per-branch sequences (Sprint 2 / O2)
-- Used for gap-free invoice numbers; incremented inside the owning transaction.
-- ===========================================================================

CREATE TABLE `branch_counters` (
  `company_id` BINARY(16) NOT NULL,
  `branch_id` BINARY(16) NOT NULL,
  `kind` VARCHAR(30) NOT NULL,
  `seq` BIGINT NOT NULL DEFAULT 0,
  `updated_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`branch_id`, `kind`),
  KEY `branch_counters_company_id_idx` (`company_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `branch_counters` ADD CONSTRAINT `branch_counters_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `branch_counters` ADD CONSTRAINT `branch_counters_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
