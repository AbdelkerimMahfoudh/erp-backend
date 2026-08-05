-- 0021 — Per-branch delegated permissions (F1 Stage 2, docs/23 §4 Stage 2).
--
-- ADDITIVE ONLY: one new table. Nothing existing is altered or dropped, so every
-- current user, assignment and permission is untouched.
--
-- One row = one Owner-delegated permission for ONE assignment (a specific user in
-- a specific branch). The composite primary key (user_branch_id, permission_id)
-- enforces "one grant per assignment per permission". The user_branch foreign key
-- is ON DELETE CASCADE, so removing a branch assignment removes its grants
-- automatically — a stale grant can never outlive the assignment it scoped.
--
-- What the schema does NOT encode, enforced in code instead (rbac/permission-scope.ts,
-- access.service): the delegatable allow-list (only `price.edit` today; never
-- discount.override / user.manage / settings.manage), and that a grant is honoured
-- only on a store_manager assignment (so a downgrade neutralizes it). The
-- `price.edit` permission row itself is reference data applied by the seed, like
-- the rest of the catalogue.
--
-- The migrations ledger makes this run once; it writes no data, so it cannot
-- duplicate anything on re-deploy.

-- CreateTable
CREATE TABLE `user_branch_permissions` (
    `company_id` BINARY(16) NOT NULL,
    `user_branch_id` BINARY(16) NOT NULL,
    `permission_id` BINARY(16) NOT NULL,
    `granted_by_id` BINARY(16) NOT NULL,
    `granted_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `user_branch_permissions_company_id_idx`(`company_id`),
    INDEX `user_branch_permissions_permission_id_idx`(`permission_id`),
    PRIMARY KEY (`user_branch_id`, `permission_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `user_branch_permissions` ADD CONSTRAINT `user_branch_permissions_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_branch_permissions` ADD CONSTRAINT `user_branch_permissions_user_branch_id_fkey` FOREIGN KEY (`user_branch_id`) REFERENCES `user_branches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_branch_permissions` ADD CONSTRAINT `user_branch_permissions_permission_id_fkey` FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_branch_permissions` ADD CONSTRAINT `user_branch_permissions_granted_by_id_fkey` FOREIGN KEY (`granted_by_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
