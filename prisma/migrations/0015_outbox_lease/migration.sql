-- Lease-based claiming and retry backoff for the learning outbox.
--
-- `claimed_until` is a LEASE, not a lock: a worker claims a row until a
-- deadline. If it dies mid-process the lease simply expires and the row becomes
-- claimable again, so an abandoned claim recovers on its own rather than
-- wedging the event forever.
--
-- `next_attempt_at` drives exponential backoff. Without it a permanently
-- failing event would be retried every sweep, turning one bad row into constant
-- load on a shop's database.
--
-- Reverse:
--   ALTER TABLE `recognition_outbox`
--     DROP COLUMN `claimed_until`, DROP COLUMN `next_attempt_at`;

ALTER TABLE `recognition_outbox`
  ADD COLUMN `claimed_until`   DATETIME(6) NULL,
  ADD COLUMN `next_attempt_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6);

-- Sweep predicate: due pending rows and expired leases, oldest first.
CREATE INDEX `recognition_outbox_due_idx`
  ON `recognition_outbox` (`status`, `next_attempt_at`, `claimed_until`);
