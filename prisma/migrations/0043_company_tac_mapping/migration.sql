-- 0043 — a company teaches its OWN TAC mapping, never the shared catalogue
--
-- Closes the last open question of Milestone C (`docs/30` §2.3), with the
-- product decision now made: a per-company overlay.
--
-- ## Why this is small
--
-- The audit found the overlay already largely exists. `product_recognition` is
-- company-scoped, keyed `(company_id, code_type, code)`, already carries
-- `code_type = 'tac'`, and already has the learning statistics and confidence
-- scorer the recognition system uses. **Building a second mapping table would
-- have been the competing evidence system the brief forbids.**
--
-- What it lacked is the authority distinction: today `learn()` writes a mapping
-- outright, with no notion of "an Employee proposed this" versus "an Owner
-- confirmed it", and no record of who did either.
--
-- ## The two layers, and why they never touch
--
--   `tac_catalog`         GLOBAL, platform-controlled, generic manufacturer and
--                         model only. **No store user may write to it**, and it
--                         must never point at one tenant's Product — it has no
--                         `company_id` and no `product_id`, by design.
--
--   `product_recognition` COMPANY-scoped. Maps a TAC to *that company's own*
--                         Product. Learned from explicit confirmation. Cannot
--                         affect another company, because every query is
--                         scoped by the tenant extension.
--
-- Purely additive: six columns and two constraints on an existing table. No
-- existing row is rewritten — every current mapping is backfilled to
-- `confirmed`, which is what it effectively already was.
--
-- Rerun-safe: every statement is guarded.

-- 1. Lifecycle and authority --------------------------------------------------
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'product_recognition'
      AND column_name = 'status') = 0,
  "ALTER TABLE `product_recognition`
     -- `proposed` is an Employee's suggestion and is NEVER authoritative.
     -- `confirmed` is an Owner's or Manager's decision. `superseded` is a
     -- mapping that was replaced — kept, never deleted, so the history of what
     -- a shop believed about a TAC survives.
     ADD COLUMN `status` ENUM('proposed','confirmed','superseded') NOT NULL DEFAULT 'confirmed',
     ADD COLUMN `proposed_by_id`  BINARY(16) NULL,
     ADD COLUMN `confirmed_by_id` BINARY(16) NULL,
     ADD COLUMN `confirmed_at`    DATETIME(6) NULL,
     -- Where the evidence came from: `receiving`, `scan`, `sale`, `manual`.
     ADD COLUMN `evidence_source` VARCHAR(24) NULL,
     -- Optimistic concurrency: two managers confirming one TAC, one winner.
     ADD COLUMN `version` INT NOT NULL DEFAULT 0,
     ADD COLUMN `updated_at` DATETIME(6) NOT NULL
       DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
     ADD CONSTRAINT `fk_prodrec_proposed_by`
       FOREIGN KEY (`proposed_by_id`) REFERENCES `users` (`id`),
     ADD CONSTRAINT `fk_prodrec_confirmed_by`
       FOREIGN KEY (`confirmed_by_id`) REFERENCES `users` (`id`)",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

/*
 * Existing rows keep the meaning they already had. Every mapping written before
 * this migration was created by a confirmation flow, so `confirmed` is the
 * honest backfill — and the DEFAULT above makes it automatic.
 *
 * Deliberately NOT relying on the seed: `prisma migrate deploy` never runs it
 * (the D2.1 lesson), so a deployed database would otherwise get nothing.
 */
UPDATE `product_recognition`
   SET `confirmed_at` = COALESCE(`last_confirmed_at`, `created_at`)
 WHERE `status` = 'confirmed' AND `confirmed_at` IS NULL;

-- 2. One ACTIVE confirmed mapping per company and TAC -------------------------
-- The existing `@@unique(company_id, code_type, code)` allowed exactly one row
-- per code full stop, which cannot express "one confirmed mapping alongside a
-- pending proposal". It is replaced by the partial-unique pattern `0002`
-- established: the generated column carries the code only while the row is
-- confirmed, and NULL otherwise. So one confirmed mapping and any number of
-- proposals or superseded rows can coexist.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'product_recognition'
      AND column_name = 'active_code') = 0,
  "ALTER TABLE `product_recognition`
     ADD COLUMN `active_code` VARCHAR(64)
       GENERATED ALWAYS AS (IF(`status` = 'confirmed', `code`, NULL)) VIRTUAL,
     ADD UNIQUE KEY `ux_prodrec_active` (`company_id`, `code_type`, `active_code`)",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- The old absolute unique goes only after its replacement exists.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'product_recognition'
      AND index_name = 'product_recognition_company_id_code_type_code_key') > 0,
  'ALTER TABLE `product_recognition`
     DROP INDEX `product_recognition_company_id_code_type_code_key`',
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- Lookups by code are now non-unique, so they need their own index.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'product_recognition'
      AND index_name = 'ix_prodrec_lookup') = 0,
  'ALTER TABLE `product_recognition`
     ADD KEY `ix_prodrec_lookup` (`company_id`, `code_type`, `code`, `status`)',
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- 3. A TAC is exactly eight digits -------------------------------------------
-- Enforced in the database, not only in the service: a mapping keyed on a
-- malformed TAC would never match anything and would be invisible until
-- somebody wondered why recognition had stopped working for one model.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'product_recognition'
      AND constraint_name = 'ck_prodrec_tac_format') = 0,
  "ALTER TABLE `product_recognition`
     ADD CONSTRAINT `ck_prodrec_tac_format` CHECK (
       `code_type` <> 'tac' OR `code` REGEXP '^[0-9]{8}$'
     )",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- A confirmed mapping must say who confirmed it and when.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'product_recognition'
      AND constraint_name = 'ck_prodrec_confirmed_fields') = 0,
  "ALTER TABLE `product_recognition`
     ADD CONSTRAINT `ck_prodrec_confirmed_fields` CHECK (
       `status` <> 'confirmed' OR `confirmed_at` IS NOT NULL
     )",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- Reverse SQL (not executed; kept so a rollback is a decision, not a puzzle):
--   ALTER TABLE `product_recognition`
--     DROP CHECK `ck_prodrec_tac_format`,
--     DROP CHECK `ck_prodrec_confirmed_fields`,
--     DROP INDEX `ux_prodrec_active`,
--     DROP INDEX `ix_prodrec_lookup`,
--     DROP COLUMN `active_code`,
--     DROP FOREIGN KEY `fk_prodrec_proposed_by`,
--     DROP FOREIGN KEY `fk_prodrec_confirmed_by`,
--     DROP COLUMN `status`, DROP COLUMN `proposed_by_id`,
--     DROP COLUMN `confirmed_by_id`, DROP COLUMN `confirmed_at`,
--     DROP COLUMN `evidence_source`, DROP COLUMN `version`,
--     DROP COLUMN `updated_at`,
--     ADD UNIQUE KEY `product_recognition_company_id_code_type_code_key`
--       (`company_id`, `code_type`, `code`);
