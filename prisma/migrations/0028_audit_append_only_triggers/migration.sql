-- ===========================================================================
-- 0028_audit_append_only_triggers
--
-- Moves the audit_logs append-only guard from a manual init script into the
-- migration chain.
--
-- Why: prisma/sql/init/10_audit_append_only.sql had to be run by hand, as root,
-- after migrations. The development database happens to have had it run once.
-- A clean database built from all migrations had ZERO audit_logs triggers, so a
-- fresh production deployment would have shipped a fully mutable audit log --
-- silently, because nothing fails when a guard is merely absent. Grants cannot
-- substitute: partial_revokes is schema-level only, so a schema-level grant
-- cannot carve out one table.
--
-- 0027 proved the migrator may create triggers, so the guard belongs here where
-- deployment cannot forget it. This mirrors 0027's price_change_events triggers.
--
-- Idempotent by design: DROP IF EXISTS then CREATE, so it is safe on databases
-- that already ran the init script. Re-creating them changes the DEFINER from
-- root to the migrator, which is irrelevant -- the guard tests USER(), the
-- session account, which is unaffected by the definer.
--
-- 0027 is NOT modified. This migration is purely additive.
-- ===========================================================================

DROP TRIGGER IF EXISTS `audit_logs_block_update`;

DROP TRIGGER IF EXISTS `audit_logs_block_delete`;

CREATE TRIGGER `audit_logs_block_update` BEFORE UPDATE ON `audit_logs`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only for the application user';
  END IF;
END;

CREATE TRIGGER `audit_logs_block_delete` BEFORE DELETE ON `audit_logs`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only for the application user';
  END IF;
END;
