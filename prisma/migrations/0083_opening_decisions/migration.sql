-- 0083 — The opening decision: what a shop's cash starts from when it opens (docs/63).
--
-- Why: the Owner's opening of the boutique now includes the money it opens with (the user's brief of
-- 2026-09-28). At each opening or reopen the drawer is either kept as the app tracks it, set by the
-- Owner to what is in it at that moment, or — opened by a permitted non-Owner — carried forward and
-- marked as awaiting the Owner's review until the Owner keeps or sets it. Nothing in the schema held
-- that decision, its amounts, its author or its moment.
--
-- A set amount is a position, never a sale or an expense: from its instant the drawer holds that
-- amount plus what the day records after it. `cash_day_net` is the day's recorded cash movement at
-- that instant, so the Daily closing and Money add only what came after — nothing is backdated and
-- nothing counted twice. The company's accounts are never set here (they carry forward; changing one
-- is the Owner's company-wide `money/anchors`): `methods` only records what each showed.
--
-- Additive: one new table and its append-only triggers. No existing row changes.

CREATE TABLE IF NOT EXISTS `opening_decisions` (
  `id`                  BINARY(16)    NOT NULL,
  `company_id`          BINARY(16)    NOT NULL,
  `branch_id`           BINARY(16)    NOT NULL,
  /** The business date opened, or whose opening the Owner reviewed. */
  `business_date`       DATE          NOT NULL,
  `kind`                ENUM('opening', 'owner_review') NOT NULL,
  /** keep: as tracked · set: the Owner's amount · carried: a non-Owner opened; awaiting the Owner's review. */
  `decision`            ENUM('keep', 'set', 'carried') NOT NULL,
  /** The opened / reopened event recorded in the same transaction (an opening). */
  `closing_event_id`    BINARY(16)    NULL,
  /** The opening this review answers (an Owner review). */
  `review_of_id`        BINARY(16)    NULL,
  /** The server clock at confirmation: a set amount is true from this instant. */
  `at`                  DATETIME(6)   NOT NULL,
  /** Whether the app knew what the drawer held just before. */
  `cash_known`          TINYINT(1)    NOT NULL,
  /** The Daily closing's expected cash at `at`, the figure a set amount is compared with. */
  `cash_tracked`        DECIMAL(14,2) NOT NULL,
  /** set: the Owner's amount · keep / carried: the tracked amount, NULL when it was unknown. */
  `cash_amount`         DECIMAL(14,2) NULL,
  /** The business day's recorded net cash movement at `at`. */
  `cash_day_net`        DECIMAL(14,2) NOT NULL,
  /** Every method as the person saw it: [{key, channel, accountId, label, scope, previous, amount, set}]. */
  `methods`             JSON          NOT NULL,
  /** The total shown before confirming; NULL when any method was unknown. */
  `total`               DECIMAL(14,2) NULL,
  `recorded_by_id`      BINARY(16)    NOT NULL,
  `client_uuid`         BINARY(16)    NOT NULL,
  `client_request_hash` CHAR(64)      NOT NULL,
  `created_at`          DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_opening_decisions_client_uuid` (`company_id`, `client_uuid`),
  UNIQUE KEY `ux_opening_decisions_review` (`review_of_id`),
  KEY `ix_opening_decisions_branch_day` (`branch_id`, `business_date`, `at`),
  KEY `ix_opening_decisions_event` (`closing_event_id`),
  KEY `ix_opening_decisions_recorded_by` (`recorded_by_id`),
  CONSTRAINT `fk_opening_decisions_company`     FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_opening_decisions_branch`      FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_opening_decisions_event`       FOREIGN KEY (`closing_event_id`) REFERENCES `closing_events` (`id`),
  CONSTRAINT `fk_opening_decisions_review_of`   FOREIGN KEY (`review_of_id`) REFERENCES `opening_decisions` (`id`),
  CONSTRAINT `fk_opening_decisions_recorded_by` FOREIGN KEY (`recorded_by_id`) REFERENCES `users` (`id`),
  CONSTRAINT `ck_opening_decisions_amount`      CHECK (`cash_amount` IS NULL OR `cash_amount` >= 0),
  CONSTRAINT `ck_opening_decisions_set`         CHECK (`decision` <> 'set' OR `cash_amount` IS NOT NULL),
  CONSTRAINT `ck_opening_decisions_kind`        CHECK (
    (`kind` = 'opening' AND `review_of_id` IS NULL)
    OR (`kind` = 'owner_review' AND `review_of_id` IS NOT NULL AND `decision` <> 'carried')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Append-only for the application account, as every financial record here (0028, 0036, 0040, 0079, 0082).
DROP TRIGGER IF EXISTS `opening_decisions_block_update`;
CREATE TRIGGER `opening_decisions_block_update`
BEFORE UPDATE ON `opening_decisions`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'opening_decisions is append-only: an Owner review is a new row';
  END IF;
END;

DROP TRIGGER IF EXISTS `opening_decisions_block_delete`;
CREATE TRIGGER `opening_decisions_block_delete`
BEFORE DELETE ON `opening_decisions`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'opening_decisions is append-only: a decision is never deleted';
  END IF;
END;

-- Reverse SQL (not executed):
--   DROP TRIGGER IF EXISTS `opening_decisions_block_update`;
--   DROP TRIGGER IF EXISTS `opening_decisions_block_delete`;
--   DROP TABLE IF EXISTS `opening_decisions`;
