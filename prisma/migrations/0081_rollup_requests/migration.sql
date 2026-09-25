-- 0081: durable requests to recompute the daily figures (docs/52).
--
-- Every change that moves a day's figures — a sale, an expense confirmed, a return
-- approved, a refund confirmed, a correction approved — used to ask for the rollup
-- recompute AFTER its transaction committed, in memory (fire-and-forget, or awaited
-- and then failing the request). If the API stopped in that window, or the
-- recompute failed, the change was committed and the day's rollup never learned of
-- it: Results and branch goals read low until something else touched that day.
--
-- The request is now a row written INSIDE the business transaction: it commits with
-- the change or not at all. A worker drains it after commit, at start-up and on a
-- timer. The recompute rebuilds the whole branch-day from its source records, so
-- working a request twice can never count a sale twice.
--
-- `kind`: `daily` recomputes one branch-day (`day` set); `branch` refreshes the
-- branch's stock snapshots — valuation and velocity (`day` NULL).
-- Rows are kept once done: the history of when each branch-day was last recomputed,
-- and why.

CREATE TABLE IF NOT EXISTS `rollup_requests` (
  `id`               BINARY(16)   NOT NULL,
  `company_id`       BINARY(16)   NOT NULL,
  `branch_id`        BINARY(16)   NOT NULL,
  `kind`             ENUM('daily', 'branch') NOT NULL,
  `day`              DATE         NULL,
  /** What asked: sale, expense_confirmed, return_approved, refund_confirmed, correction_approved, purchase_received, transfer_shipped, transfer_received. */
  `cause`            VARCHAR(32)  NOT NULL,
  /** The record that asked, for tracing a stale day back to its cause. */
  `source_id`        BINARY(16)   NULL,
  `status`           ENUM('pending', 'processing', 'done') NOT NULL DEFAULT 'pending',
  `attempts`         INT          NOT NULL DEFAULT 0,
  `last_error`       VARCHAR(500) NULL,
  `requested_at`     DATETIME(6)  NOT NULL,
  `next_attempt_at`  DATETIME(6)  NOT NULL,
  /** The worker pass that holds the row; with `claimed_until` a lease, never a lock. */
  `claim_token`      BINARY(16)   NULL,
  `claimed_until`    DATETIME(6)  NULL,
  `processed_at`     DATETIME(6)  NULL,
  PRIMARY KEY (`id`),
  KEY `ix_rr_due` (`status`, `next_attempt_at`),
  KEY `ix_rr_claim` (`claim_token`),
  KEY `ix_rr_scope` (`branch_id`, `kind`, `day`),
  KEY `ix_rr_company` (`company_id`),
  CONSTRAINT `fk_rr_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_rr_branch`  FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`),
  CONSTRAINT `ck_rr_day`     CHECK ((`kind` = 'daily') = (`day` IS NOT NULL)),
  CONSTRAINT `ck_rr_attempts` CHECK (`attempts` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
