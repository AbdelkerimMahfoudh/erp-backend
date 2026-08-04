-- Store-facing roles: owner / store_manager / store_employee.
--
-- ADDITIVE ONLY. The legacy members stay in the enum so existing rows remain
-- valid while data is remapped; retiring them is a separate later migration,
-- safe only once no `user_branches` row references them AND the seed no longer
-- writes them.
--
-- Why the merge: `sales_employee` and `warehouse_employee` split one real job.
-- The split is what produced the 403 where the employee responsible for
-- receiving merchandise could not call the purchase endpoint.
--
-- Data remapping lives in the seed rather than here, because the permission
-- matrix is defined in TypeScript (prisma/seed-data/permissions.ts) and
-- duplicating it as SQL would let the two drift. The seed is idempotent and
-- records the exact before/after mapping.
--
-- Reverse (only valid before any store_* assignment exists):
--   ALTER TABLE `roles` MODIFY `key`
--     ENUM('owner','administrator','branch_manager','sales_employee','warehouse_employee') NOT NULL;

ALTER TABLE `roles` MODIFY `key` ENUM(
  'owner',
  'administrator',
  'branch_manager',
  'sales_employee',
  'warehouse_employee',
  'store_manager',
  'store_employee'
) NOT NULL;
