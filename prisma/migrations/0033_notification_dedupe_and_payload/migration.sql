-- H1.3 CP2 — make a duplicate transition notification structurally impossible,
-- and let the app say the same thing in Arabic.
--
-- WHY THIS IS ADDITIVE ONLY
-- Two nullable columns and one unique index on `notifications`. No existing row
-- changes, no data is copied, and every current notification keeps working
-- exactly as it does today (both new columns are NULL for them).
--
-- 1. `dedupe_key`
--    Transfers now notify people on every lifecycle transition. An
--    application-level "have I already sent this?" read cannot promise
--    exactly-once: it is true when checked and false when acted on, and a
--    retried request would send a second copy. The unique index below makes the
--    DATABASE the arbiter — a duplicate INSERT is rejected, not merely avoided.
--
--    Key shape: `transfer:<32 hex chars>:<event>` — one row per recipient per
--    transfer per event. 120 chars leaves ample room.
--
--    NULLs do not collide in a MySQL unique index, which is exactly what we
--    want: every existing notification, and any future one that has no natural
--    identity, keeps behaving as an ordinary insert.
--
-- 2. `payload`
--    `title` and `body` are stored text, written in English by the server. A
--    shop running in Arabic would read English notifications forever. Storing
--    the FIELDS (branch names, transfer reference, counts) instead lets the app
--    compose the sentence in the reader's language, while `title`/`body` remain
--    as the fallback for any client that does not know the type.
--
--    It carries branch names, the transfer reference, an actor name, an item
--    COUNT and a decision reason. It deliberately carries no cost, no price and
--    no margin: a notification is read outside the request that authorized it,
--    so it must never become a way around cost gating.
--
-- REVERSE SQL (tested):
--   DROP INDEX `notifications_company_target_dedupe_key` ON `notifications`;
--   ALTER TABLE `notifications` DROP COLUMN `payload`, DROP COLUMN `dedupe_key`;

ALTER TABLE `notifications`
  ADD COLUMN `dedupe_key` VARCHAR(120) NULL AFTER `action_link`,
  ADD COLUMN `payload` JSON NULL AFTER `dedupe_key`;

CREATE UNIQUE INDEX `notifications_company_target_dedupe_key`
  ON `notifications` (`company_id`, `target_user_id`, `dedupe_key`);
