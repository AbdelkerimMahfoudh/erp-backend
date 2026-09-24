-- 0077: the physical opening of the boutique (docs/50 §6).
--
-- The 06:00 boundary starts a REPORTING date; it never says when a person
-- unlocked the door. That opening is an explicit act somebody records, with
-- its instant and its actor, in the same timeline the closing already keeps.
-- One value is added to the event kind; nothing else changes and no row moves.
ALTER TABLE `closing_events`
  MODIFY `kind` ENUM('count_saved','closed','reopened','auto_reopened','reclosed','day_started_early','opened') NOT NULL;
