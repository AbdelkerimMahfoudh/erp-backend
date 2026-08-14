-- ===========================================================================
-- 0036_returns_workflow  (Phase I2)
--
-- The reviewed return: a request an employee raises, a manager investigates,
-- and a manager or owner approves or rejects — creating a refund OBLIGATION,
-- never a payment.
--
-- Three new tables, two additive reporting columns sets, six permissions.
-- Nothing existing is rewritten. The audit is `docs/27` §16.
--
-- ---------------------------------------------------------------------------
-- WHY NOT REUSE THE EXISTING `returns` TABLE
-- ---------------------------------------------------------------------------
-- It holds ZERO rows and its shape encodes the exact defect I1 removed: a
-- client-supplied `refund_amount` and `restock BOOLEAN DEFAULT TRUE`, which put
-- a possibly-defective phone back on the shelf. Reusing it would reintroduce
-- the vocabulary of the bug. It is left in place, unused and deprecated —
-- dropping it is destructive, needs its own decision, and buys nothing while it
-- is empty.
--
-- ---------------------------------------------------------------------------
-- ONE ACTIVE CLAIM PER SALE LINE, ENFORCED BY THE DATABASE
-- ---------------------------------------------------------------------------
-- MySQL has no partial unique index. The project already solves this with a
-- VIRTUAL generated column plus a UNIQUE key, exploiting the fact that MySQL
-- treats NULLs in a unique index as distinct — `sale_items.active_unit_id`
-- (0002) is the same trick for sold-once.
--
--   claim_key = 1     for pending_investigation, under_review, approved_refund_due
--   claim_key = NULL  for rejected
--
-- so UNIQUE (sale_item_id, claim_key) permits any number of historical rejected
-- requests and exactly one unresolved-or-approved claim.
--
-- A CHECK tying status to the key state was considered and deliberately NOT
-- added: the column is GENERATED from `status`, so the tie is definitional and
-- application code cannot set it wrong. A CHECK here could only ever be
-- tautologically true, and a constraint that cannot fail is a constraint that
-- misleads whoever reads it next.
--
-- `return_reversals.sale_item_id` is UNIQUE as an independent second guarantee:
-- even if a claim key were somehow wrong, a sale line can be approved once.
--
-- ---------------------------------------------------------------------------
-- CUSTODY (docs/27 §16.2)
-- ---------------------------------------------------------------------------
--   customer_holds  request raised, phone still with the customer  → Unit stays `sold`
--   store_holds     the shop physically received it                → Unit becomes `returned`
--   handed_back     rejected and returned to the customer          → Unit back to `sold`
--   retained_hold   approved, kept unsellable pending inspection   → Unit becomes `faulty`
--
-- Approval REQUIRES store custody. `returned` and `faulty` units are already
-- un-sellable, un-priceable and un-transferable: all three gates independently
-- require `in_stock`.
--
-- ---------------------------------------------------------------------------
-- MONEY
-- ---------------------------------------------------------------------------
-- Gross refund is taken from the IMMUTABLE original sale line, never from the
-- client. Adjustments (screen protector consumed, accessory retained) are
-- explicit positive lines; the server sums them.
--
--   net_refund_due = gross_refund - adjustment_total,  and never negative.
--
-- Both are CHECK-enforced. Every money CHECK uses non-FK columns only: MySQL
-- error 3823 forbids a CHECK over a column that participates in a foreign key
-- with a referential action, a limitation 0002 already documents.
--
-- ---------------------------------------------------------------------------
-- REPORTING: POSITIVE VALUES, SUBTRACTED EXPLICITLY
-- ---------------------------------------------------------------------------
-- `daily_rollups` and `daily_closings` both gain returns columns storing
-- POSITIVE magnitudes. Calculations subtract them. Storing a negative revenue
-- would make every consumer guess whether the sign was already applied, and a
-- guess that is wrong once is wrong permanently in a closed day.
--
-- `daily_rollups` is derived and recomputed per branch-day, so the returns
-- component is keyed on the APPROVAL date and cannot disturb the sale's own
-- day. `daily_closings` is an immutable locked snapshot: a closing created
-- AFTER an approval records that day's return figures, and an approval on an
-- already-closed day is refused by the application with a 409 rather than
-- reopening anything.
--
-- ---------------------------------------------------------------------------
-- REVERSE SQL (executed against a restored copy, not merely written down)
--
--   DROP TRIGGER IF EXISTS `return_reversals_block_delete`;
--   DROP TRIGGER IF EXISTS `return_reversals_block_update`;
--   DELETE rp FROM `role_permissions` rp JOIN `permissions` p ON p.`id` = rp.`permission_id`
--     WHERE p.`key` IN ('return.view','return.request','return.review','return.approve','return.reject','return.exception');
--   DELETE FROM `permissions` WHERE `key` IN ('return.view','return.request','return.review','return.approve','return.reject','return.exception');
--   ALTER TABLE `daily_closings` DROP COLUMN `total_returns_profit_impact`, DROP COLUMN `total_returns`;
--   ALTER TABLE `daily_rollups` DROP COLUMN `returns_count`, DROP COLUMN `returns_gross_profit`,
--     DROP COLUMN `returns_cogs`, DROP COLUMN `returns_revenue`;
--   DROP TABLE IF EXISTS `return_adjustments`;
--   DROP TABLE IF EXISTS `return_reversals`;
--   DROP TABLE IF EXISTS `return_requests`;
--
-- Drop order matters: adjustments and reversals reference requests.
--
-- ---------------------------------------------------------------------------
-- RERUN SAFETY
-- ---------------------------------------------------------------------------
-- `prisma migrate deploy` records applied migrations and never replays one, so
-- in the normal deployment path this file runs exactly once. It is written to
-- survive a replay anyway, because the one time a migration IS re-run by hand
-- is during an incident, and that is the worst moment to discover it is not
-- idempotent.
--
--   * tables      CREATE TABLE IF NOT EXISTS
--   * columns     MySQL has no ADD COLUMN IF NOT EXISTS, so each ALTER is
--                 guarded by an information_schema probe and executed through a
--                 prepared statement. One sentinel column per ALTER is enough:
--                 the columns in a single statement exist together or not at all
--   * triggers    DROP IF EXISTS then CREATE
--   * permissions INSERT … WHERE NOT EXISTS
--
-- Proven by applying this file twice in a row to a restored database and
-- confirming the second run changes nothing.
-- ===========================================================================

-- 1. The request -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `return_requests` (
  `id`                  BINARY(16) NOT NULL,
  `company_id`          BINARY(16) NOT NULL,
  `branch_id`           BINARY(16) NOT NULL,
  `sale_id`             BINARY(16) NOT NULL,
  `sale_item_id`        BINARY(16) NOT NULL,
  `unit_id`             BINARY(16) NOT NULL,

  `status` ENUM('pending_investigation','under_review','approved_refund_due','rejected')
    NOT NULL DEFAULT 'pending_investigation',

  -- One active claim per sale line. See the header.
  `claim_key` TINYINT GENERATED ALWAYS AS (IF(`status` = 'rejected', NULL, 1)) VIRTUAL,

  -- Offline-safe creation. The hash makes a replayed key with a DIFFERENT
  -- payload a 409 rather than a silent no-op — the Purchase/StockTransfer
  -- pattern.
  `client_uuid`         BINARY(16) NOT NULL,
  `client_request_hash` CHAR(64) NOT NULL,

  `requested_by`        BINARY(16) NULL,
  `request_reason`      VARCHAR(255) NOT NULL,
  `condition_notes`     TEXT NULL,

  `responsibility` ENUM('pending_investigation','store_or_product_fault','customer_damage','other')
    NOT NULL DEFAULT 'pending_investigation',
  `responsibility_notes` VARCHAR(255) NULL,

  `custody` ENUM('customer_holds','store_holds','handed_back','retained_hold')
    NOT NULL DEFAULT 'customer_holds',
  `custody_received_at` DATETIME(6) NULL,
  `custody_returned_at` DATETIME(6) NULL,

  -- The I1 policy snapshot, copied at request time so a later settings change
  -- cannot alter what this request was raised under.
  `policy_window_hours` INT NOT NULL,
  `policy_deadline_at`  DATETIME(6) NULL,
  `policy_reason`       VARCHAR(40) NOT NULL,
  `requires_exception`  BOOLEAN NOT NULL DEFAULT 0,

  `reviewed_by`         BINARY(16) NULL,
  `reviewed_at`         DATETIME(6) NULL,
  `decided_by`          BINARY(16) NULL,
  `decided_at`          DATETIME(6) NULL,
  `decision_reason`     TEXT NULL,
  `exception_reason`    VARCHAR(255) NULL,

  -- Approve versus reject must have exactly one winner.
  `version`             INT NOT NULL DEFAULT 0,
  `created_at`          DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`          DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_return_requests_active_claim` (`sale_item_id`, `claim_key`),
  UNIQUE KEY `ux_return_requests_client_uuid` (`company_id`, `client_uuid`),
  KEY `ix_return_requests_company_status` (`company_id`, `status`),
  KEY `ix_return_requests_branch_status` (`branch_id`, `status`),
  KEY `ix_return_requests_sale` (`sale_id`),
  KEY `ix_return_requests_unit` (`unit_id`),
  KEY `ix_return_requests_requested_by` (`requested_by`),
  CONSTRAINT `fk_return_requests_company`   FOREIGN KEY (`company_id`)   REFERENCES `companies` (`id`),
  CONSTRAINT `fk_return_requests_branch`    FOREIGN KEY (`branch_id`)    REFERENCES `branches` (`id`),
  CONSTRAINT `fk_return_requests_sale`      FOREIGN KEY (`sale_id`)      REFERENCES `sales` (`id`),
  CONSTRAINT `fk_return_requests_sale_item` FOREIGN KEY (`sale_item_id`) REFERENCES `sale_items` (`id`),
  CONSTRAINT `fk_return_requests_unit`      FOREIGN KEY (`unit_id`)      REFERENCES `units` (`id`),
  CONSTRAINT `fk_return_requests_requester` FOREIGN KEY (`requested_by`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_return_requests_reviewer`  FOREIGN KEY (`reviewed_by`)  REFERENCES `users` (`id`),
  CONSTRAINT `fk_return_requests_decider`   FOREIGN KEY (`decided_by`)   REFERENCES `users` (`id`),
  CONSTRAINT `return_requests_window_chk` CHECK (`policy_window_hours` >= 0 AND `policy_window_hours` <= 8760)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 2. Adjustments -------------------------------------------------------------
-- Explicit, never inferred: accessory linkage cannot be derived from a sale
-- that carries two phones and one accessory line (docs/27 §16.4).

CREATE TABLE IF NOT EXISTS `return_adjustments` (
  `id`                BINARY(16) NOT NULL,
  `company_id`        BINARY(16) NOT NULL,
  `return_request_id` BINARY(16) NOT NULL,
  `kind` ENUM('screen_protector','accessory_retained','restocking_fee','other') NOT NULL,
  `label`             VARCHAR(160) NOT NULL,
  `quantity`          INT NOT NULL DEFAULT 1,
  `unit_amount`       DECIMAL(14,2) NOT NULL,
  `total_amount`      DECIMAL(14,2) NOT NULL,
  `created_by`        BINARY(16) NULL,
  `created_at`        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (`id`),
  KEY `ix_return_adjustments_request` (`return_request_id`),
  KEY `ix_return_adjustments_company` (`company_id`),
  CONSTRAINT `fk_return_adjustments_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_return_adjustments_request` FOREIGN KEY (`return_request_id`) REFERENCES `return_requests` (`id`),
  CONSTRAINT `fk_return_adjustments_user`    FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  -- Non-negative money, and a quantity that means something.
  CONSTRAINT `return_adjustments_qty_pos_chk`      CHECK (`quantity` > 0),
  CONSTRAINT `return_adjustments_unit_nonneg_chk`  CHECK (`unit_amount` >= 0),
  CONSTRAINT `return_adjustments_total_nonneg_chk` CHECK (`total_amount` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 3. The immutable reversal --------------------------------------------------
-- Written once at approval, from the ORIGINAL sale line. Never recomputed from
-- product or pricing records, which move.

CREATE TABLE IF NOT EXISTS `return_reversals` (
  `id`                BINARY(16) NOT NULL,
  `company_id`        BINARY(16) NOT NULL,
  `branch_id`         BINARY(16) NOT NULL,
  `sale_id`           BINARY(16) NOT NULL,
  `sale_item_id`      BINARY(16) NOT NULL,
  `unit_id`           BINARY(16) NOT NULL,
  `return_request_id` BINARY(16) NOT NULL,

  -- Snapshots of the original line, so the reversal remains true even if the
  -- catalogue, the price or the cost of that product changes later.
  `line_revenue`      DECIMAL(14,2) NOT NULL,
  `line_cost`         DECIMAL(14,2) NOT NULL,
  `line_margin`       DECIMAL(14,2) NOT NULL,

  `gross_refund`      DECIMAL(14,2) NOT NULL,
  `adjustment_total`  DECIMAL(14,2) NOT NULL DEFAULT 0,
  `net_refund_due`    DECIMAL(14,2) NOT NULL,

  -- The BUSINESS date the reversal belongs to. Not the sale's day.
  `approval_date`     DATE NOT NULL,
  `approved_by`       BINARY(16) NULL,
  `created_at`        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  PRIMARY KEY (`id`),
  -- A sale line can be reversed once, and a request produces one reversal.
  UNIQUE KEY `ux_return_reversals_sale_item` (`sale_item_id`),
  UNIQUE KEY `ux_return_reversals_request` (`return_request_id`),
  KEY `ix_return_reversals_branch_date` (`branch_id`, `approval_date`),
  KEY `ix_return_reversals_company_date` (`company_id`, `approval_date`),
  CONSTRAINT `fk_return_reversals_company`   FOREIGN KEY (`company_id`)   REFERENCES `companies` (`id`),
  CONSTRAINT `fk_return_reversals_branch`    FOREIGN KEY (`branch_id`)    REFERENCES `branches` (`id`),
  CONSTRAINT `fk_return_reversals_sale`      FOREIGN KEY (`sale_id`)      REFERENCES `sales` (`id`),
  CONSTRAINT `fk_return_reversals_sale_item` FOREIGN KEY (`sale_item_id`) REFERENCES `sale_items` (`id`),
  CONSTRAINT `fk_return_reversals_unit`      FOREIGN KEY (`unit_id`)      REFERENCES `units` (`id`),
  CONSTRAINT `fk_return_reversals_request`   FOREIGN KEY (`return_request_id`) REFERENCES `return_requests` (`id`),
  CONSTRAINT `fk_return_reversals_user`      FOREIGN KEY (`approved_by`)  REFERENCES `users` (`id`),
  CONSTRAINT `return_reversals_gross_nonneg_chk` CHECK (`gross_refund` >= 0),
  CONSTRAINT `return_reversals_adj_nonneg_chk`   CHECK (`adjustment_total` >= 0),
  CONSTRAINT `return_reversals_net_nonneg_chk`   CHECK (`net_refund_due` >= 0),
  -- The arithmetic is a constraint, not a convention.
  CONSTRAINT `return_reversals_net_math_chk`
    CHECK (`net_refund_due` = `gross_refund` - `adjustment_total`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 4. Append-only guard on the reversal ---------------------------------------
-- Same shape as `audit_logs` (0028) and `price_change_events` (0027): the guard
-- tests USER() at run time, so it blocks the APPLICATION account and leaves the
-- migrator free — which is exactly what keeps `docs/22`'s restore path working.
-- Restoring a dump replays INSERTs as the migrator and must not be blocked.
--
-- Idempotent: DROP IF EXISTS then CREATE, so a rerun changes nothing.

DROP TRIGGER IF EXISTS `return_reversals_block_update`;

DROP TRIGGER IF EXISTS `return_reversals_block_delete`;

CREATE TRIGGER `return_reversals_block_update` BEFORE UPDATE ON `return_reversals`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'return_reversals is append-only for the application user';
  END IF;
END;

CREATE TRIGGER `return_reversals_block_delete` BEFORE DELETE ON `return_reversals`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'return_reversals is append-only for the application user';
  END IF;
END;

-- 5. Reporting ---------------------------------------------------------------
-- POSITIVE magnitudes, subtracted explicitly by every consumer.

SET @needed := (
  SELECT COUNT(*) = 0 FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'daily_rollups' AND column_name = 'returns_revenue'
);
SET @ddl := IF(@needed, 'ALTER TABLE `daily_rollups` ADD COLUMN `returns_revenue` DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER `net_profit`, ADD COLUMN `returns_cogs` DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER `returns_revenue`, ADD COLUMN `returns_gross_profit` DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER `returns_cogs`, ADD COLUMN `returns_count` INT NOT NULL DEFAULT 0 AFTER `returns_gross_profit`', 'DO 0');
PREPARE add_returns_revenue FROM @ddl;
EXECUTE add_returns_revenue;
DEALLOCATE PREPARE add_returns_revenue;

-- The locked snapshot gains the same figures, so a day closed AFTER an approval
-- records what was reversed on it. Existing closings keep 0, which is the
-- literal truth: no return had been approved when they were locked.
SET @needed := (
  SELECT COUNT(*) = 0 FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'daily_closings' AND column_name = 'total_returns'
);
SET @ddl := IF(@needed, 'ALTER TABLE `daily_closings` ADD COLUMN `total_returns` DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER `total_profit`, ADD COLUMN `total_returns_profit_impact` DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER `total_returns`', 'DO 0');
PREPARE add_total_returns FROM @ddl;
EXECUTE add_total_returns;
DEALLOCATE PREPARE add_total_returns;

-- 6. Permissions -------------------------------------------------------------
-- `migrate deploy` never runs the seed, so the grants live here (the D2.1
-- lesson). Every statement is guarded, so a rerun changes nothing. All six are
-- absent from COMPANY_PERMISSIONS and are therefore branch-scoped, fail-closed.

INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'return.view', 'View returns'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'return.view');

INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'return.request', 'Raise a return request'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'return.request');

INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'return.review', 'Investigate and assign responsibility'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'return.review');

INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'return.approve', 'Approve a return (creates a refund obligation)'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'return.approve');

INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'return.reject', 'Reject a return'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'return.reject');

INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'return.exception', 'Approve outside policy, or against customer damage'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'return.exception');

-- Owner: everything.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` IN ('return.view','return.request','return.review','return.approve','return.reject','return.exception')
WHERE r.`key` = 'owner'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- Store manager: everything EXCEPT the exception authority. A manager may
-- approve a normal, in-window, store-fault return; stepping outside the policy
-- the shop promised, or overriding customer-caused damage, is the Owner's.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` IN ('return.view','return.request','return.review','return.approve','return.reject')
WHERE r.`key` = 'store_manager'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- Store employee: see returns and raise one. Nothing else. The person who takes
-- the complaint at the counter is not the person who decides it.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` IN ('return.view','return.request')
WHERE r.`key` = 'store_employee'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );
