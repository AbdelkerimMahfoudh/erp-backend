-- D227: an Owner's payment proof from the web portal, and an administrator's decision on it.
-- Additive: a new table. The file lives here so it shares the database's encrypted, verified backups; it is cleared a
-- year after the decision (`purged_at`), while the decision itself stays.
-- Reverse, only before any proof exists: DROP TABLE payment_proofs;
CREATE TABLE `payment_proofs` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `idempotency_key` VARCHAR(80) NOT NULL,
  `status` ENUM('submitted', 'under_review', 'approved', 'refused') NOT NULL DEFAULT 'submitted',
  `amount` DECIMAL(14, 2) NOT NULL,
  `paid_at` DATETIME(6) NOT NULL,
  `reference` VARCHAR(120) NULL,
  `note` VARCHAR(500) NULL,
  `content_type` VARCHAR(40) NOT NULL,
  `byte_size` INT NOT NULL,
  `sha256` CHAR(64) NOT NULL,
  `file` MEDIUMBLOB NULL,
  `submitted_by` BINARY(16) NOT NULL,
  `submitted_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `refusal_reason` VARCHAR(500) NULL,
  `months` INT NULL,
  `applied_at` DATETIME(6) NULL,
  `decided_at` DATETIME(6) NULL,
  `purged_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_payment_proofs_key` (`company_id`, `idempotency_key`),
  KEY `ix_payment_proofs_status` (`status`, `submitted_at`),
  KEY `ix_payment_proofs_sha` (`company_id`, `sha256`),
  CONSTRAINT `fk_payment_proofs_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
