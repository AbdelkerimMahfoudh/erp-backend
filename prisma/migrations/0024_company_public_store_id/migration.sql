-- 0024 — Public Store Account ID (F1 Stage 3.2).
--
-- Adds a human-typable, NON-secret public identifier to `companies` so a login
-- can name its tenant before authentication. It is not the binary `id`, a branch
-- id, a device id or a subscription id. Canonical form = 10 uppercase hex chars.
--
-- ADDITIVE. Nothing existing is altered or dropped; every user, branch, session
-- and device is untouched. Three steps, in order, so it is safe on a table that
-- already has rows AND on a fresh (empty) database:
--
--   1. add the column nullable;
--   2. backfill every existing company, collision-free — SHA2(id) is unique per
--      unique id (no birthday risk from distinct ids) and non-sequential, so it
--      diffuses the UUIDv7 timestamp and does not expose company order/count.
--      Guarded on IS NULL, so re-running this UPDATE never changes an existing
--      code (rerun-safety for the generation logic);
--   3. enforce NOT NULL + UNIQUE now that every row has one.
--
-- On a clean migrate-deploy (no seed) `companies` is empty here: step 2 touches
-- 0 rows and steps 1/3 succeed on the empty table. New companies then receive a
-- random code from the application (`generateStoreCode`) with a unique-index
-- retry — no manually maintained seed dependency, and the NOT NULL constraint
-- makes it impossible to create a company without one.

-- 1. Additive nullable column.
ALTER TABLE `companies` ADD COLUMN `public_store_id` VARCHAR(16) NULL;

-- 2. Backfill existing companies (guarded, collision-free, non-sequential).
UPDATE `companies`
SET `public_store_id` = UPPER(SUBSTRING(SHA2(`id`, 256), 1, 10))
WHERE `public_store_id` IS NULL;

-- 3. Enforce presence + uniqueness.
ALTER TABLE `companies` MODIFY COLUMN `public_store_id` VARCHAR(16) NOT NULL;
CREATE UNIQUE INDEX `companies_public_store_id_key` ON `companies`(`public_store_id`);
