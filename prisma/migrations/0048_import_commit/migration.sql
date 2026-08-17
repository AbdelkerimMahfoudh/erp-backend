-- 0048 — make the import tables able to hold a real two-phase import
--
-- ## What the G0 audit found
--
-- `import_batches` and `import_rows` already existed, unused, since the
-- original schema. Somebody modelled the right shape — parse, preview, commit,
-- with per-row valid/warning/error — and no code was ever written against it.
--
-- What the shape was missing, and why each one matters:
--
-- 1. **No record of what the columns meant.** A preview guesses the mapping and
--    shows it; the commit that follows must use the SAME mapping, or the shop
--    approves one thing and gets another. Snapshotted, not re-guessed.
-- 2. **No warning counter.** Rows could be `warning` but the batch could only
--    count valid and error, so a preview could not say "3 need a look".
-- 3. **No commit record.** Nothing said who committed a batch or when, and
--    nothing stopped the same batch being committed twice.
-- 4. **No link from a row to what it created.** After an import there was no
--    way to get from line 47 of the spreadsheet to the phone it produced.
-- 5. **No original filename.** `file_ref` is a storage key; a shop needs to see
--    `stock-august.xlsx`.
--
-- Purely additive. Both tables are empty in every environment.
--
-- Rerun-safe: guarded.

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'import_batches'
      AND column_name = 'kind') = 0,
  "ALTER TABLE `import_batches`
     /*
      * What the sheet describes, decided by which identifier column it carries
      * rather than asked. A column of IMEIs is phones; asking again would be
      * asking somebody to restate their own file.
      */
     ADD COLUMN `kind` ENUM('imei','serial','quantity') NULL,

     -- What the shop actually called their file.
     ADD COLUMN `original_filename` VARCHAR(255) NULL,

     /*
      * The confirmed column mapping, frozen at preview. The commit reads this
      * and never re-guesses — otherwise a shop approves a preview built from
      * one interpretation and receives stock built from another.
      */
     ADD COLUMN `mapping` JSON NULL,

     -- Rows that will import but are worth a look. Missing entirely before.
     ADD COLUMN `warning_rows` INT NOT NULL DEFAULT 0,

     ADD COLUMN `committed_at` DATETIME(6) NULL,
     ADD COLUMN `committed_by_id` BINARY(16) NULL,
     -- How many rows the commit actually created, which is not the same as
     -- how many the preview predicted if anything changed in between.
     ADD COLUMN `imported_rows` INT NOT NULL DEFAULT 0,

     -- An offline retry must not import the same file twice.
     ADD COLUMN `client_uuid` BINARY(16) NULL,
     -- Optimistic concurrency: two people committing one batch, one winner.
     ADD COLUMN `version` INT NOT NULL DEFAULT 0,

     ADD CONSTRAINT `fk_import_batches_committed_by`
       FOREIGN KEY (`committed_by_id`) REFERENCES `users` (`id`)",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'import_batches'
      AND index_name = 'ux_import_batches_client_uuid') = 0,
  'ALTER TABLE `import_batches`
     ADD UNIQUE KEY `ux_import_batches_client_uuid` (`company_id`, `client_uuid`),
     ADD KEY `ix_import_batches_status` (`company_id`, `branch_id`, `status`, `created_at`)',
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- A committed batch says who and when; one that is not committed claims
-- neither. Both directions, so a half-written commit cannot exist.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'import_batches'
      AND constraint_name = 'ck_import_batches_commit') = 0,
  "ALTER TABLE `import_batches` ADD CONSTRAINT `ck_import_batches_commit`
     CHECK ((`status` = 'committed')
              = (`committed_at` IS NOT NULL AND `committed_by_id` IS NOT NULL))",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- Where each row ended up ------------------------------------------------------
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'import_rows'
      AND column_name = 'created_entity_id') = 0,
  "ALTER TABLE `import_rows`
     /*
      * The unit or stock row this line produced. Without it there is no way to
      * get from line 47 of a spreadsheet to the phone it created — which is the
      * first thing anybody asks when an import looks wrong.
      *
      * Not a foreign key: it points at one of two tables depending on `kind`,
      * and a row that produced nothing keeps NULL.
      */
     ADD COLUMN `created_entity_id` BINARY(16) NULL,
     ADD COLUMN `created_kind` ENUM('unit','stock_item') NULL,
     -- The identifier this row claimed, extracted so duplicate detection and
     -- the commit do not have to re-read the JSON.
     ADD COLUMN `identifier` VARCHAR(64) NULL",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'import_rows'
      AND index_name = 'ix_import_rows_identifier') = 0,
  'ALTER TABLE `import_rows`
     ADD KEY `ix_import_rows_identifier` (`company_id`, `identifier`),
     ADD KEY `ix_import_rows_batch_status` (`batch_id`, `status`)',
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- A committed batch is a record of what was brought in. Deleting one would
-- leave stock in the shop with no explanation of where it came from.
DROP TRIGGER IF EXISTS `import_batches_block_delete`;
CREATE TRIGGER `import_batches_block_delete`
BEFORE DELETE ON `import_batches`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' AND OLD.`status` = 'committed' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'A committed import is the record of where stock came from and is never deleted';
  END IF;
END;

-- Reverse SQL (not executed):
--   DROP TRIGGER IF EXISTS `import_batches_block_delete`;
--   ALTER TABLE `import_rows`
--     DROP INDEX `ix_import_rows_identifier`, DROP INDEX `ix_import_rows_batch_status`,
--     DROP COLUMN `created_entity_id`, DROP COLUMN `created_kind`,
--     DROP COLUMN `identifier`;
--   ALTER TABLE `import_batches`
--     DROP CHECK `ck_import_batches_commit`,
--     DROP FOREIGN KEY `fk_import_batches_committed_by`,
--     DROP INDEX `ux_import_batches_client_uuid`, DROP INDEX `ix_import_batches_status`,
--     DROP COLUMN `kind`, DROP COLUMN `original_filename`, DROP COLUMN `mapping`,
--     DROP COLUMN `warning_rows`, DROP COLUMN `committed_at`,
--     DROP COLUMN `committed_by_id`, DROP COLUMN `imported_rows`,
--     DROP COLUMN `client_uuid`, DROP COLUMN `version`;
