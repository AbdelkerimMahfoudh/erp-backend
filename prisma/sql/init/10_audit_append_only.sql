-- ===========================================================================
-- 10_audit_append_only.sql — SUPERSEDED by migration
-- `0028_audit_append_only_triggers`. Do not run this for a new deployment;
-- `prisma migrate deploy` now creates these triggers itself.
--
-- Kept only so existing runbooks that reference it still resolve, and as the
-- explanation of *why* the guard is a trigger. It remains safe to run (it drops
-- before creating), but it is no longer the source of truth.
--
-- It was a manual step for too long: a clean database built from every
-- migration had NO audit_logs triggers at all, so a fresh production deployment
-- would have had a fully mutable audit log until someone remembered this file.
-- Nothing fails when a guard is merely absent, which is what made it dangerous.
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
