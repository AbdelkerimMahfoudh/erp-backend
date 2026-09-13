-- 0071 — a connection request can be withdrawn, and a connection ended.
--
-- WHY
-- The Partners milestone makes an ACCEPTED connection the only thing that may
-- authorise new inter-store dealings. That needs two states the relationship
-- could not express:
--
--   cancelled  the requester withdrew a request before it was answered;
--   removed    either store ended an accepted connection.
--
-- Both stop new business exactly as `rejected` and `blocked` already do, and
-- neither touches anything owed or held: consignments, loans, their ledgers,
-- custody and audit rows keep their `connection_id` and remain settleable.
--
-- WHAT THIS DOES NOT CHANGE
-- Existing values keep their meaning and position; nothing is backfilled; the
-- unique `pair_key` is untouched, so a pair still has exactly one relationship
-- row — a cancelled, rejected or removed pair is reopened by reusing that row.

ALTER TABLE `store_connections`
  MODIFY COLUMN `status`
  ENUM('pending','accepted','rejected','blocked','cancelled','removed')
  NOT NULL DEFAULT 'pending';
