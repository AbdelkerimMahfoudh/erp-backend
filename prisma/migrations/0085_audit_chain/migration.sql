-- ===========================================================================
-- 0085 — A tamper-evident audit trail (docs/48 §8.1, docs/65).
--
-- Why: the append-only triggers of 0028 stop the APPLICATION account from
-- rewriting `audit_logs`. They cannot stop a database administrator, a
-- restored backup edited on the way in, or anybody holding the migrator's
-- password — and an audit trail that can be quietly rewritten by the people
-- with the most access is worth the least exactly when it matters. This adds
-- a hash chain per company, so any row changed, removed or inserted out of
-- order breaks a link that `scripts/verify-audit-chain.ts` recomputes.
--
-- ## How
--
--  - `audit_logs.prev_hash` / `entry_hash`: each row carries the previous
--    row's hash (per company) and its own, SHA-256 over the row's content.
--  - `audit_chain_heads`: the last hash per company, locked FOR UPDATE by the
--    trigger below so two concurrent inserts for one company are serialised
--    and the chain never forks.
--  - The BEFORE INSERT trigger computes both hashes for EVERY insert, whatever
--    inserted it: the API, an administrator script, a restore. Nothing in
--    application code can forget to chain a row, because the database does it.
--  - Existing rows are sealed once, in order, by the procedure at the end:
--    from this migration on there is no unchained row.
--
-- ## What is hashed
--
-- Every column that carries meaning, in a fixed order, joined by '|'; the
-- binary ids as hex; JSON as MySQL's own canonical text; the instant to the
-- microsecond. The verifier recomputes the same expression in the same SQL
-- functions, so there is no second implementation to drift.
--
-- ## Cost
--
-- One locked read and one update of a single row per audit insert, inside
-- the inserting transaction. Concurrent audit writes for the SAME company
-- serialise on that row for the tail of their transactions; different
-- companies never wait on each other.
--
-- Reverse:
--   DROP TRIGGER IF EXISTS `audit_logs_chain`;
--   DROP TABLE `audit_chain_heads`;
--   ALTER TABLE `audit_logs` DROP COLUMN `entry_hash`, DROP COLUMN `prev_hash`, DROP INDEX `ix_audit_logs_company_id_id`;
-- ===========================================================================

ALTER TABLE `audit_logs`
  ADD COLUMN `prev_hash`  CHAR(64) NULL AFTER `at`,
  ADD COLUMN `entry_hash` CHAR(64) NULL AFTER `prev_hash`,
  ADD INDEX `ix_audit_logs_company_id_id` (`company_id`, `id`);

CREATE TABLE IF NOT EXISTS `audit_chain_heads` (
  `company_id` BINARY(16)  NOT NULL,
  `last_hash`  CHAR(64)    NOT NULL,
  `entries`    BIGINT      NOT NULL DEFAULT 0,
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`company_id`),
  CONSTRAINT `fk_audit_chain_heads_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Seal what exists, in (company, id) order, before the trigger takes over.
DROP PROCEDURE IF EXISTS `audit_chain_seal`;

CREATE PROCEDURE `audit_chain_seal`()
BEGIN
  DECLARE done INT DEFAULT 0;
  DECLARE v_id BIGINT;
  DECLARE v_company BINARY(16);
  DECLARE v_branch BINARY(16);
  DECLARE v_user BINARY(16);
  DECLARE v_entity_type VARCHAR(60);
  DECLARE v_entity BINARY(16);
  DECLARE v_action VARCHAR(20);
  DECLARE v_before LONGTEXT;
  DECLARE v_after LONGTEXT;
  DECLARE v_reason TEXT;
  DECLARE v_ip VARCHAR(45);
  DECLARE v_at VARCHAR(32);
  DECLARE v_hash CHAR(64);
  DECLARE prev CHAR(64) DEFAULT '';
  DECLARE cur_company BINARY(16) DEFAULT NULL;
  DECLARE c CURSOR FOR
    SELECT `id`, `company_id`, `branch_id`, `user_id`, `entity_type`, `entity_id`, `action`,
           CAST(`before` AS CHAR), CAST(`after` AS CHAR), `reason`, `ip`,
           DATE_FORMAT(`at`, '%Y-%m-%d %H:%i:%s.%f')
    FROM `audit_logs` WHERE `entry_hash` IS NULL ORDER BY `company_id`, `id`;
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;
  OPEN c;
  seal_loop: LOOP
    FETCH c INTO v_id, v_company, v_branch, v_user, v_entity_type, v_entity, v_action, v_before, v_after, v_reason, v_ip, v_at;
    IF done = 1 THEN LEAVE seal_loop; END IF;
    IF cur_company IS NULL OR cur_company <> v_company THEN
      SET cur_company = v_company;
      SET prev = IFNULL((SELECT `last_hash` FROM `audit_chain_heads` WHERE `company_id` = v_company), '');
    END IF;
    SET v_hash = SHA2(CONCAT_WS('|', prev, HEX(v_company), IFNULL(HEX(v_branch), ''), IFNULL(HEX(v_user), ''),
                                v_entity_type, IFNULL(HEX(v_entity), ''), v_action, IFNULL(v_before, ''), IFNULL(v_after, ''),
                                IFNULL(v_reason, ''), IFNULL(v_ip, ''), v_at), 256);
    UPDATE `audit_logs` SET `prev_hash` = prev, `entry_hash` = v_hash WHERE `id` = v_id;
    INSERT INTO `audit_chain_heads` (`company_id`, `last_hash`, `entries`) VALUES (v_company, v_hash, 1)
      ON DUPLICATE KEY UPDATE `last_hash` = v_hash, `entries` = `entries` + 1;
    SET prev = v_hash;
  END LOOP;
  CLOSE c;
END;

CALL `audit_chain_seal`();

DROP PROCEDURE `audit_chain_seal`;

DROP TRIGGER IF EXISTS `audit_logs_chain`;

-- Every company gets its head row now, so the trigger's "no head yet" branch
-- runs only for a company created after this migration.
INSERT IGNORE INTO `audit_chain_heads` (`company_id`, `last_hash`, `entries`)
  SELECT `id`, '', 0 FROM `companies`;

CREATE TRIGGER `audit_logs_chain` BEFORE INSERT ON `audit_logs`
FOR EACH ROW
BEGIN
  DECLARE prev CHAR(64) DEFAULT '';
  DECLARE found INT DEFAULT 1;
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET found = 0;
  IF NEW.`at` IS NULL THEN
    SET NEW.`at` = CURRENT_TIMESTAMP(6);
  END IF;
  /*
   * The exclusive lock FIRST. An earlier version did `INSERT IGNORE` before
   * this read: the duplicate-key path of INSERT IGNORE takes a SHARED lock on
   * the existing head row, and two concurrent inserts for one company then
   * both held S and both wanted X — a deadlock, seen 5 times in 30 parallel
   * writes. Reading FOR UPDATE straight away takes X once, and the second
   * writer simply waits.
   */
  SELECT `last_hash` INTO prev FROM `audit_chain_heads` WHERE `company_id` = NEW.`company_id` FOR UPDATE;
  IF found = 0 THEN
    SET prev = '';
    INSERT INTO `audit_chain_heads` (`company_id`, `last_hash`, `entries`) VALUES (NEW.`company_id`, '', 0);
  END IF;
  SET NEW.`prev_hash` = prev;
  SET NEW.`entry_hash` = SHA2(CONCAT_WS('|', prev, HEX(NEW.`company_id`), IFNULL(HEX(NEW.`branch_id`), ''), IFNULL(HEX(NEW.`user_id`), ''),
                                        NEW.`entity_type`, IFNULL(HEX(NEW.`entity_id`), ''), NEW.`action`,
                                        IFNULL(CAST(NEW.`before` AS CHAR), ''), IFNULL(CAST(NEW.`after` AS CHAR), ''),
                                        IFNULL(NEW.`reason`, ''), IFNULL(NEW.`ip`, ''),
                                        DATE_FORMAT(NEW.`at`, '%Y-%m-%d %H:%i:%s.%f')), 256);
  UPDATE `audit_chain_heads` SET `last_hash` = NEW.`entry_hash`, `entries` = `entries` + 1 WHERE `company_id` = NEW.`company_id`;
END;
