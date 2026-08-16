-- 0042 — one identifier belongs to one phone, whichever column it sits in
--
-- Closes a defect verified against real MySQL during the Milestone C audit
-- (`docs/30` §7): the same IMEI could be one unit's PRIMARY and a different
-- unit's SECONDARY.
--
-- `ux_units_identifier` (on the generated `COALESCE(imei_primary, serial_no)`)
-- and `units_imei_secondary_key` are independent indexes. Each protects its own
-- column and nothing joins them, so all three of these were ALLOWED:
--
--   unit A: imei_primary   = X
--   unit B: imei_secondary = X        ← the same physical identifier, twice
--   unit C: imei_secondary = B's primary
--
-- Latent until now, because almost nothing wrote `imei_secondary`. **Dual-SIM
-- OCR intake is exactly the workflow that starts writing it** — on every
-- dual-SIM phone received — so this had to close before that ships.
--
-- The consequence was not cosmetic: two inventory records could claim one
-- physical identifier, a lookup would match two different phones, and sell-once
-- would rest on which column happened to be searched.
--
-- ## Why triggers rather than an identifier table
--
-- MySQL has no single-index expression spanning two columns, so the choice was
-- between a normalised `unit_identifiers` table and a trigger pair.
--
-- Triggers win here on one argument: an identifier table needs a backfill and a
-- change to every read path that looks a phone up, and each of those is a place
-- to introduce a regression in code that already works. The trigger is additive,
-- reversible, touches no query, and this codebase already enforces invariants
-- this way — the append-only guards on `sale_items`, `refund_payouts` and
-- `financial_corrections` are the same shape.
--
-- Unlike those, these fire for EVERY user including the migrator. An append-only
-- rule exempts the migrator so the documented restore in `docs/22` can rewrite
-- history; a uniqueness rule must not, because a restore that reintroduces a
-- duplicate identifier is precisely what this prevents.
--
-- ## Pre-migration audit (run against the live database, 2026-08-15)
--
--   primary_vs_secondary = 0
--   secondary_vs_serial  = 0
--   self_conflict        = 0
--
-- A database with real history MUST have that audit re-run before applying
-- this: a constraint added over dirty data fails at the worst possible moment.
--
-- Rerun-safe: both triggers are dropped before being created.

DROP TRIGGER IF EXISTS `units_identifier_unique_insert`;
CREATE TRIGGER `units_identifier_unique_insert`
BEFORE INSERT ON `units`
FOR EACH ROW
BEGIN
  /*
   * A phone may not carry the same number twice. Caught here rather than left
   * to the two column indexes, neither of which compares a row against itself.
   */
  IF NEW.imei_secondary IS NOT NULL AND NEW.imei_secondary = NEW.imei_primary THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'A unit cannot have the same IMEI as both its primary and secondary identifier';
  END IF;

  IF NEW.imei_primary IS NOT NULL AND EXISTS (
    SELECT 1 FROM `units`
     WHERE `imei_secondary` = NEW.imei_primary
        OR `serial_no`      = NEW.imei_primary
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'That IMEI already identifies another unit';
  END IF;

  IF NEW.imei_secondary IS NOT NULL AND EXISTS (
    SELECT 1 FROM `units`
     WHERE `imei_primary`   = NEW.imei_secondary
        OR `imei_secondary` = NEW.imei_secondary
        OR `serial_no`      = NEW.imei_secondary
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'That IMEI already identifies another unit';
  END IF;
END;

DROP TRIGGER IF EXISTS `units_identifier_unique_update`;
CREATE TRIGGER `units_identifier_unique_update`
BEFORE UPDATE ON `units`
FOR EACH ROW
BEGIN
  IF NEW.imei_secondary IS NOT NULL AND NEW.imei_secondary = NEW.imei_primary THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'A unit cannot have the same IMEI as both its primary and secondary identifier';
  END IF;

  /*
   * `id <> NEW.id` throughout: a unit being updated must not collide with
   * itself. Without it, saving a row without touching its identifiers would
   * fail — which would break every ordinary status change.
   */
  IF NEW.imei_primary IS NOT NULL AND EXISTS (
    SELECT 1 FROM `units`
     WHERE `id` <> NEW.id
       AND (`imei_secondary` = NEW.imei_primary OR `serial_no` = NEW.imei_primary)
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'That IMEI already identifies another unit';
  END IF;

  IF NEW.imei_secondary IS NOT NULL AND EXISTS (
    SELECT 1 FROM `units`
     WHERE `id` <> NEW.id
       AND (`imei_primary`   = NEW.imei_secondary
         OR `imei_secondary` = NEW.imei_secondary
         OR `serial_no`      = NEW.imei_secondary)
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'That IMEI already identifies another unit';
  END IF;
END;

-- Reverse SQL (not executed):
--   DROP TRIGGER IF EXISTS `units_identifier_unique_insert`;
--   DROP TRIGGER IF EXISTS `units_identifier_unique_update`;
