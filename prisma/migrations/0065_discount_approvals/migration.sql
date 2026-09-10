-- 0065 — Owner-approved exceptions to the configured selling price (A2).
--
-- Additive only: one new table, its indexes and its foreign keys. No
-- existing column is altered and no data is migrated, so a code rollback
-- leaves this table in place and unused, which is harmless.
--
-- Hand-written rather than generated. `prisma migrate diff` against the
-- migration history produced 1172 lines that dropped foreign keys across
-- unrelated tables — the history carries hand-tuned SQL (triggers,
-- generated columns) that the datamodel does not describe, so the diff
-- read the difference as drift to be undone. Only the additive part is
-- taken here.

CREATE TABLE `discount_approvals` (
    `id` BINARY(16) NOT NULL,
    `company_id` BINARY(16) NOT NULL,
    `branch_id` BINARY(16) NOT NULL,
    `unit_id` BINARY(16) NOT NULL,
    `product_id` BINARY(16) NOT NULL,
    `variant` VARCHAR(120) NULL,
    `configured_price` DECIMAL(14, 2) NOT NULL,
    `price_source` VARCHAR(32) NOT NULL,
    `price_version` INTEGER NOT NULL,
    `unit_cost` DECIMAL(14, 2) NOT NULL,
    `requested_price` DECIMAL(14, 2) NOT NULL,
    `discount_amount` DECIMAL(14, 2) NOT NULL,
    `below_cost` BOOLEAN NOT NULL DEFAULT false,
    `unit_branch_id` BINARY(16) NOT NULL,
    `requester_id` BINARY(16) NOT NULL,
    `reason` VARCHAR(255) NULL,
    `status` ENUM('pending', 'approved', 'rejected', 'expired', 'voided', 'consumed') NOT NULL DEFAULT 'pending',
    `approver_id` BINARY(16) NULL,
    `decided_at` DATETIME(3) NULL,
    `approved_price` DECIMAL(14, 2) NULL,
    `decision_note` VARCHAR(255) NULL,
    `consumed_by_sale_id` BINARY(16) NULL,
    `consumed_at` DATETIME(3) NULL,
    `void_reason` VARCHAR(64) NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `client_uuid` BINARY(16) NULL,
    `client_request_hash` VARCHAR(64) NULL,

    INDEX `discount_approvals_company_id_status_created_at_idx`(`company_id`, `status`, `created_at`),
    INDEX `discount_approvals_unit_id_status_idx`(`unit_id`, `status`),
    UNIQUE INDEX `discount_approvals_company_id_client_uuid_key`(`company_id`, `client_uuid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;


ALTER TABLE `discount_approvals` ADD CONSTRAINT `discount_approvals_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `discount_approvals` ADD CONSTRAINT `discount_approvals_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `discount_approvals` ADD CONSTRAINT `discount_approvals_unit_id_fkey` FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `discount_approvals` ADD CONSTRAINT `discount_approvals_requester_id_fkey` FOREIGN KEY (`requester_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `discount_approvals` ADD CONSTRAINT `discount_approvals_approver_id_fkey` FOREIGN KEY (`approver_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
