-- ===========================================================================
-- 10_audit_append_only.sql — run ONCE, as root/DBA, AFTER migrations create the
-- tables. Run with a client that honours DELIMITER (the mysql CLI does).
-- ---------------------------------------------------------------------------
-- MySQL cannot carve a single table out of a schema-level grant (partial_revokes
-- is schema-level only). So `audit_logs` append-only is enforced with triggers
-- that block UPDATE/DELETE *for the application user* (USER() returns the session
-- account, unaffected by the trigger's definer). An admin/DBA (root, migrator)
-- can still archive by time range.
-- ===========================================================================

DROP TRIGGER IF EXISTS `audit_logs_block_update`;
DROP TRIGGER IF EXISTS `audit_logs_block_delete`;

DELIMITER //

CREATE TRIGGER `audit_logs_block_update` BEFORE UPDATE ON `audit_logs`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only for the application user';
  END IF;
END//

CREATE TRIGGER `audit_logs_block_delete` BEFORE DELETE ON `audit_logs`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only for the application user';
  END IF;
END//

DELIMITER ;
