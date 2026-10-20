-- ===========================================================================
-- 0102 — Persistent test businesses on the one deployed application (the owner's decision of 2026-10-20; D217).
--
-- Why: the owner authorised controlled testing on tsxmr-app-01 and its production API through persistent, explicitly
-- marked test businesses, instead of a second server. A test business is an ordinary tenant — the same tenancy, roles,
-- permissions and audit — that the platform must tell apart from a customer:
--
--   - the platform's customer counts leave it out, while its own reports and audit history stay whole;
--   - it connects only to other test businesses (search, lookup and connection requests), so it never trades with a
--     real store, and a business with connections cannot change its test status;
--   - nothing is ever paid for it: the console refuses payments and payment confirmations, and access is given only by
--     an explicit, audited administrative grant through the existing entitlement model;
--   - while customer activation is closed (CUSTOMER_ACTIVATION, closed by default in production), the console's owner
--     setup invitation and the actions that grant access are allowed for test businesses only.
--
-- `is_test` is set and cleared only by a platform administrator — at creation, or with its own audited action — and
-- `test_marked_at` / `test_marked_by` say when and by whom it last changed. Nothing ever wipes or resets a test
-- business: it stays until an administrator decides otherwise, like any business.
--
-- Additive: three columns with defaults; every existing business stays a customer business (`is_test` = 0). No row
-- changes and nothing is dropped.
--
-- Reverse (only after a restore point; older code ignores the columns, so an application rollback does not need it):
--   ALTER TABLE `companies` DROP COLUMN `test_marked_by`, DROP COLUMN `test_marked_at`, DROP COLUMN `is_test`;
-- ===========================================================================

ALTER TABLE `companies`
  ADD COLUMN `is_test` TINYINT(1) NOT NULL DEFAULT 0 AFTER `closed_at`,
  ADD COLUMN `test_marked_at` DATETIME(6) NULL AFTER `is_test`,
  ADD COLUMN `test_marked_by` VARCHAR(160) NULL AFTER `test_marked_at`;
