-- 0049 — inter-store consignment
--
-- ## Why this is not a StockTransfer
--
-- `stock_transfers` moves inventory between BRANCHES OF ONE COMPANY. Ownership
-- never changes, both ends are governed by branch assignment, and every query
-- is scoped by the tenant extension to a single `company_id`.
--
-- A consignment is a different thing wearing similar clothes: it is between two
-- SEPARATE COMPANIES (or a manual counterparty), custody moves while ownership
-- does not, the phone can be resold by somebody who does not own it, and the
-- whole point is that it creates a receivable on one side and a payable on the
-- other. Extending `stock_transfers` would have put two tenants' data in a
-- table whose every read assumes one, which is the exact shape of a
-- cross-tenant leak.
--
-- ## The central risk, stated plainly
--
-- `consignments` is the FIRST table in this schema that legitimately belongs to
-- two companies at once. It therefore cannot be scoped automatically by
-- `tenant.extension.ts`, and the guard that has protected every other table
-- stops protecting this one.
--
-- The mitigation is not "be careful". It is:
--   - both company columns are NOT NULL-able independently: `source_company_id`
--     is always set, `destination_company_id` is set for an application
--     counterparty and NULL for a manual one;
--   - every service read goes through one helper that filters
--     `source_company_id = me OR destination_company_id = me`, and a spec
--     asserts no query bypasses it;
--   - the per-side privacy columns live on separate tables, so a leak requires
--     joining rather than merely forgetting a filter.
--
-- ## What is deliberately NOT here
--
-- No second owned `unit` in the destination company. Store 2 receives custody,
-- not ownership, and materialising a duplicate unit would create two rows that
-- can be sold independently — the double-sale this whole design exists to make
-- impossible.
--
-- Rerun-safe: every statement is guarded.

-- 1. A company can choose to be findable -------------------------------------
-- Everything added here becomes visible to strangers, so it is opt-in and
-- defaults to invisible. Publication is a decision, not a default.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'companies'
      AND column_name = 'is_discoverable') = 0,
  "ALTER TABLE `companies`
     /*
      * Off until the Owner turns it on. A shop that never heard of consignment
      * must not be searchable by every other shop by default.
      */
     ADD COLUMN `is_discoverable` TINYINT(1) NOT NULL DEFAULT 0,
     /* Coarse location only. Never an address — a city narrows a search, an
      * address identifies a building full of stock. */
     ADD COLUMN `city` VARCHAR(120) NULL,
     ADD COLUMN `logo_ref` VARCHAR(512) NULL,
     /*
      * Shown only AFTER a connection is accepted. Held here rather than in
      * `settings` because it is published data with a visibility rule, and
      * burying it in a JSON blob is how visibility rules get forgotten.
      */
     ADD COLUMN `public_phone` VARCHAR(40) NULL",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'companies'
      AND index_name = 'ix_companies_discovery') = 0,
  'ALTER TABLE `companies` ADD KEY `ix_companies_discovery` (`is_discoverable`, `name`)',
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- 2. The trust relationship between two shops --------------------------------
CREATE TABLE IF NOT EXISTS `store_connections` (
  `id` BINARY(16) NOT NULL,

  /*
   * Who asked and who was asked. Kept as roles rather than "company_a/b"
   * because the request direction matters: only the addressee may accept.
   */
  `requester_company_id` BINARY(16) NOT NULL,
  `addressee_company_id` BINARY(16) NOT NULL,

  `status` ENUM('pending','accepted','rejected','blocked') NOT NULL DEFAULT 'pending',

  /*
   * Either side may block, so who did it must be recorded — otherwise the
   * blocked party could simply unblock themselves.
   *
   * Blocking stops NEW requests. It never deletes history and never erases an
   * outstanding liability: a shop cannot escape what it owes by blocking the
   * creditor.
   */
  `blocked_by_company_id` BINARY(16) NULL,
  `blocked_at` DATETIME(6) NULL,
  `block_reason` VARCHAR(255) NULL,

  `requested_by_id` BINARY(16) NULL,
  `decided_by_id`   BINARY(16) NULL,
  `decided_at`      DATETIME(6) NULL,
  `note`            VARCHAR(255) NULL,

  `version`    INT NOT NULL DEFAULT 0,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  /*
   * One relationship per pair of shops, whichever way round it was requested.
   * Ordered by hex so A→B and B→A collapse to the same key — without this, two
   * shops could each hold a pending request to the other and neither would be
   * able to accept cleanly.
   */
  `pair_key` VARCHAR(66) AS (
    IF(HEX(`requester_company_id`) < HEX(`addressee_company_id`),
       CONCAT(HEX(`requester_company_id`), ':', HEX(`addressee_company_id`)),
       CONCAT(HEX(`addressee_company_id`), ':', HEX(`requester_company_id`)))
  ) STORED,

  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_store_connections_pair` (`pair_key`),
  KEY `ix_store_connections_requester` (`requester_company_id`, `status`),
  KEY `ix_store_connections_addressee` (`addressee_company_id`, `status`),
  KEY `ix_store_connections_blocked_by` (`blocked_by_company_id`),
  KEY `ix_store_connections_requested_by` (`requested_by_id`),
  KEY `ix_store_connections_decided_by` (`decided_by_id`),
  CONSTRAINT `fk_conn_requester` FOREIGN KEY (`requester_company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_conn_addressee` FOREIGN KEY (`addressee_company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_conn_blocked_by` FOREIGN KEY (`blocked_by_company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_conn_requested_by` FOREIGN KEY (`requested_by_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_conn_decided_by` FOREIGN KEY (`decided_by_id`) REFERENCES `users` (`id`),

  -- A shop cannot connect to itself.
  CONSTRAINT `ck_conn_not_self` CHECK (`requester_company_id` <> `addressee_company_id`),
  -- Blocked states name who blocked and when; unblocked states claim neither.
  CONSTRAINT `ck_conn_blocked` CHECK (
    (`status` = 'blocked') = (`blocked_by_company_id` IS NOT NULL AND `blocked_at` IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Who the other party is, from one company's point of view ----------------
-- Tenant-scoped and shared with Milestone I: a loan and a consignment can be
-- against the same shop or the same person, and duplicating the concept would
-- make "who owes us money" two different lists.
CREATE TABLE IF NOT EXISTS `counterparties` (
  `id`         BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,

  /*
   *   `connected_store` — a real company on this platform, via a connection.
   *   `manual_store`    — a shop that does not use the app.
   *   `manual_person`   — an individual.
   *   `employee`        — a member of staff (Milestone I only).
   *
   * A manual counterparty is NEVER a fake `companies` row. Inventing a company
   * would give it a Store Account ID, a tenant scope and a login path, none of
   * which it should have.
   */
  `kind` ENUM('connected_store','manual_store','manual_person','employee') NOT NULL,

  `connected_company_id` BINARY(16) NULL,
  `connection_id`        BINARY(16) NULL,
  `user_id`              BINARY(16) NULL,

  -- For manual counterparties, and as the display name for connected ones so a
  -- rename on their side cannot silently retitle our historical records.
  `name`  VARCHAR(160) NOT NULL,
  `phone` VARCHAR(40)  NULL,
  `city`  VARCHAR(120) NULL,
  `note`  VARCHAR(255) NULL,

  `is_active`  TINYINT(1) NOT NULL DEFAULT 1,
  `version`    INT NOT NULL DEFAULT 0,
  `created_by_id` BINARY(16) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  -- One counterparty row per connected company, so two consignments to the same
  -- shop share a ledger rather than splitting it.
  `connected_key` VARCHAR(40) AS (
    IF(`connected_company_id` IS NULL, NULL, HEX(`connected_company_id`))
  ) VIRTUAL,

  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_counterparties_connected` (`company_id`, `connected_key`),
  KEY `ix_counterparties_company` (`company_id`, `kind`, `is_active`),
  KEY `ix_counterparties_connection` (`connection_id`),
  KEY `ix_counterparties_user` (`user_id`),
  KEY `ix_counterparties_created_by` (`created_by_id`),
  CONSTRAINT `fk_cp_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_cp_connected` FOREIGN KEY (`connected_company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_cp_connection` FOREIGN KEY (`connection_id`) REFERENCES `store_connections` (`id`),
  CONSTRAINT `fk_cp_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_cp_created_by` FOREIGN KEY (`created_by_id`) REFERENCES `users` (`id`),

  -- The kind and its columns agree, in both directions.
  CONSTRAINT `ck_cp_kind` CHECK (
    (`kind` = 'connected_store' AND `connected_company_id` IS NOT NULL AND `user_id` IS NULL)
    OR (`kind` = 'employee' AND `user_id` IS NOT NULL AND `connected_company_id` IS NULL)
    OR (`kind` IN ('manual_store','manual_person')
        AND `connected_company_id` IS NULL AND `user_id` IS NULL)
  ),
  CONSTRAINT `ck_cp_name` CHECK (TRIM(`name`) <> ''),
  -- A shop is never its own counterparty.
  CONSTRAINT `ck_cp_not_self` CHECK (`connected_company_id` IS NULL
                                     OR `connected_company_id` <> `company_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. The consignment itself — the cross-tenant record ------------------------
CREATE TABLE IF NOT EXISTS `consignments` (
  `id` BINARY(16) NOT NULL,

  -- Always set. The company that owns the stock and carries the receivable.
  `source_company_id` BINARY(16) NOT NULL,
  `source_branch_id`  BINARY(16) NOT NULL,

  /*
   * Set for an application counterparty, NULL for a manual one. This column is
   * what makes the record cross-tenant, and it is why `consignments` cannot be
   * scoped automatically — every read must filter on
   * `source_company_id = me OR destination_company_id = me`.
   */
  `destination_company_id` BINARY(16) NULL,
  -- The source's own view of who this went to, always set.
  `counterparty_id`        BINARY(16) NOT NULL,
  `connection_id`          BINARY(16) NULL,

  /*
   * Detailed internal states. The UI groups them into Pending / Accepted /
   * Confirmed, but the record keeps the distinctions — "accepted" and "the
   * phone is physically there" are different facts, and collapsing them is how
   * a shop ends up believing stock moved when it did not.
   */
  `status` ENUM(
    'draft','requested','counter_proposed','disputed','accepted_awaiting_custody',
    'custody_awaiting_confirmation','in_custody','sold_awaiting_settlement',
    'partially_paid','return_initiated','return_in_transit',
    'settled','returned_accepted','forgiven_settled','cancelled'
  ) NOT NULL DEFAULT 'draft',

  /*
   * The money. `proposed` is what the source asked for, `counter` what the
   * destination came back with, and `agreed` is what both sides settled on.
   *
   * `agreed_amount` becomes IMMUTABLE once custody is confirmed — after that
   * the phone is in somebody else's shop and the price cannot move under them.
   */
  `proposed_amount` DECIMAL(14,2) NULL,
  `counter_amount`  DECIMAL(14,2) NULL,
  `agreed_amount`   DECIMAL(14,2) NULL,

  -- A dispute must say why. "Rejected" with no reason is not a conversation.
  `dispute_reason` VARCHAR(255) NULL,
  `note`           VARCHAR(255) NULL,

  `proposed_by_id`  BINARY(16) NULL,
  `decided_by_id`   BINARY(16) NULL,
  `decided_at`      DATETIME(6) NULL,
  `custody_sent_at`      DATETIME(6) NULL,
  `custody_sent_by_id`   BINARY(16) NULL,
  `custody_confirmed_at` DATETIME(6) NULL,
  `custody_confirmed_by_id` BINARY(16) NULL,
  `settled_at`      DATETIME(6) NULL,

  `client_uuid` BINARY(16) NULL,
  `version`     INT NOT NULL DEFAULT 0,
  `created_at`  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_consignments_client_uuid` (`source_company_id`, `client_uuid`),
  KEY `ix_consignments_source` (`source_company_id`, `status`, `created_at`),
  KEY `ix_consignments_destination` (`destination_company_id`, `status`, `created_at`),
  KEY `ix_consignments_counterparty` (`counterparty_id`),
  KEY `ix_consignments_branch` (`source_branch_id`),
  KEY `ix_consignments_connection` (`connection_id`),
  CONSTRAINT `fk_cons_source` FOREIGN KEY (`source_company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_cons_branch` FOREIGN KEY (`source_branch_id`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_cons_destination` FOREIGN KEY (`destination_company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_cons_counterparty` FOREIGN KEY (`counterparty_id`) REFERENCES `counterparties` (`id`),
  CONSTRAINT `fk_cons_connection` FOREIGN KEY (`connection_id`) REFERENCES `store_connections` (`id`),

  -- A shop cannot consign to itself.
  CONSTRAINT `ck_cons_not_self` CHECK (`destination_company_id` IS NULL
                                       OR `destination_company_id` <> `source_company_id`),
  -- Amounts are positive when present. A consignment for nothing is a gift.
  CONSTRAINT `ck_cons_amounts` CHECK (
    (`proposed_amount` IS NULL OR `proposed_amount` > 0)
    AND (`counter_amount` IS NULL OR `counter_amount` > 0)
    AND (`agreed_amount` IS NULL OR `agreed_amount` > 0)
  ),
  -- A dispute states its reason.
  CONSTRAINT `ck_cons_dispute` CHECK (
    `status` <> 'disputed' OR TRIM(COALESCE(`dispute_reason`, '')) <> ''
  ),
  /*
   * Custody confirmed implies an agreed amount. This is the constraint that
   * makes "the price is immutable after custody" enforceable rather than
   * merely intended — there is nothing to freeze if nothing was agreed.
   */
  CONSTRAINT `ck_cons_custody_agreed` CHECK (
    `custody_confirmed_at` IS NULL OR `agreed_amount` IS NOT NULL
  ),
  CONSTRAINT `ck_cons_custody_attribution` CHECK (
    (`custody_confirmed_at` IS NULL) = (`custody_confirmed_by_id` IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. One phone per line ------------------------------------------------------
CREATE TABLE IF NOT EXISTS `consignment_lines` (
  `id` BINARY(16) NOT NULL,
  `consignment_id` BINARY(16) NOT NULL,
  -- Denormalised so a line can be scoped without joining its parent.
  `source_company_id` BINARY(16) NOT NULL,

  -- The source's unit. There is deliberately no destination unit: Store 2 has
  -- custody, not ownership, and a second row could be sold independently.
  `unit_id` BINARY(16) NOT NULL,

  /*
   * Snapshotted at proposal, because this is what the destination was shown and
   * agreed to. A later rename of the product in the source's catalogue must not
   * retroactively change what was consigned.
   *
   * Cost and margin are absent by design and must never be added here.
   */
  `brand`      VARCHAR(80)  NULL,
  `model`      VARCHAR(120) NOT NULL,
  `variant`    VARCHAR(120) NULL,
  `identifier` VARCHAR(64)  NOT NULL,
  `condition_note` VARCHAR(255) NULL,
  -- Defects the source chose to disclose. Explicit, so "I was not told" is
  -- answerable from the record.
  `defect_note`    VARCHAR(255) NULL,

  `agreed_amount` DECIMAL(14,2) NULL,

  `status` ENUM('proposed','in_custody','sold','returned','cancelled')
    NOT NULL DEFAULT 'proposed',
  `disposed_at` DATETIME(6) NULL,
  /*
   * How the line ended. `sold` raises the receivable; `returned` does not.
   * Recorded on the line rather than inferred from the parent, because a
   * multi-line consignment can have some sold and some returned.
   */
  `disposition` ENUM('sold','returned','damaged','forgiven') NULL,
  `return_condition` ENUM('good','damaged') NULL,
  `return_note` VARCHAR(255) NULL,

  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  /*
   * A unit can be on only ONE active consignment. MySQL has no partial unique
   * index, so the active key is generated — the `active_unit_id` precedent from
   * 0002. This is the database half of the double-claim guarantee; the
   * compare-and-swap on `units.status` is the other half.
   */
  `active_unit_id` BINARY(16) AS (
    IF(`status` IN ('proposed','in_custody'), `unit_id`, NULL)
  ) STORED,

  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_consignment_lines_active_unit` (`active_unit_id`),
  KEY `ix_consignment_lines_consignment` (`consignment_id`, `status`),
  KEY `ix_consignment_lines_unit` (`unit_id`),
  KEY `ix_consignment_lines_company` (`source_company_id`),
  CONSTRAINT `fk_cline_consignment` FOREIGN KEY (`consignment_id`) REFERENCES `consignments` (`id`),
  CONSTRAINT `fk_cline_unit` FOREIGN KEY (`unit_id`) REFERENCES `units` (`id`),
  CONSTRAINT `fk_cline_company` FOREIGN KEY (`source_company_id`) REFERENCES `companies` (`id`),

  CONSTRAINT `ck_cline_amount` CHECK (`agreed_amount` IS NULL OR `agreed_amount` > 0),
  CONSTRAINT `ck_cline_identifier` CHECK (TRIM(`identifier`) <> ''),
  -- A disposed line says how and when; an open one claims neither.
  CONSTRAINT `ck_cline_disposition` CHECK (
    (`disposition` IS NULL) = (`disposed_at` IS NULL)
  ),
  -- A returned line records the condition it came back in.
  CONSTRAINT `ck_cline_return` CHECK (
    `status` <> 'returned' OR `return_condition` IS NOT NULL
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. The money, append-only --------------------------------------------------
-- What is owed is DERIVED from these rows and stored nowhere, the same rule the
-- employee debt ledger follows in 0045.
CREATE TABLE IF NOT EXISTS `consignment_ledger` (
  `id` BINARY(16) NOT NULL,
  `consignment_id` BINARY(16) NOT NULL,
  -- Both sides, so either company can read its own ledger without a join.
  `source_company_id`      BINARY(16) NOT NULL,
  `destination_company_id` BINARY(16) NULL,

  /*
   *   `receivable_raised`  — a line sold. Increases what is owed.
   *   `payment_reported`   — money says it moved. Changes NOTHING until confirmed.
   *   `payment_confirmed`  — the creditor agrees it arrived. Decreases the balance.
   *   `payment_corrected`  — a confirmed payment reversed (Milestone B's rule).
   *   `forgiven`           — the creditor waived part or all. Not cash.
   *   `settled`            — the balance reached zero and both sides agree.
   */
  `kind` ENUM('receivable_raised','payment_reported','payment_confirmed',
              'payment_corrected','forgiven','settled') NOT NULL,

  -- Always a positive magnitude; `kind` carries the direction.
  `amount` DECIMAL(14,2) NOT NULL,

  `line_id` BINARY(16) NULL,

  -- How a payment moved. NULL for the kinds that are not payments.
  `method` ENUM('cash','account') NULL,
  `receiving_account_id` BINARY(16) NULL,
  -- Frozen: renaming an account later must not retitle a movement.
  `account_label_snapshot` VARCHAR(80) NULL,
  `reference` VARCHAR(120) NULL,
  `evidence_ref` VARCHAR(512) NULL,

  -- Mandatory for forgiveness and correction. A waiver nobody can explain is
  -- worse than no waiver at all.
  `reason` VARCHAR(255) NULL,

  -- Which side wrote this, so a two-party flow can tell report from confirm.
  `acting_company_id` BINARY(16) NOT NULL,
  `acting_user_id`    BINARY(16) NULL,
  `entry_date` DATE NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  -- An offline retry must not pay twice.
  `client_uuid` BINARY(16) NULL,
  -- The reported entry a confirmation or correction refers to.
  `refers_to_id` BINARY(16) NULL,

  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_cledger_client_uuid` (`acting_company_id`, `client_uuid`),
  KEY `ix_cledger_consignment` (`consignment_id`, `kind`),
  KEY `ix_cledger_source` (`source_company_id`, `entry_date`),
  KEY `ix_cledger_destination` (`destination_company_id`, `entry_date`),
  KEY `ix_cledger_line` (`line_id`),
  KEY `ix_cledger_account` (`receiving_account_id`),
  KEY `ix_cledger_acting_user` (`acting_user_id`),
  KEY `ix_cledger_refers` (`refers_to_id`),
  CONSTRAINT `fk_cledger_consignment` FOREIGN KEY (`consignment_id`) REFERENCES `consignments` (`id`),
  CONSTRAINT `fk_cledger_source` FOREIGN KEY (`source_company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_cledger_destination` FOREIGN KEY (`destination_company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_cledger_acting` FOREIGN KEY (`acting_company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_cledger_line` FOREIGN KEY (`line_id`) REFERENCES `consignment_lines` (`id`),
  CONSTRAINT `fk_cledger_account` FOREIGN KEY (`receiving_account_id`) REFERENCES `receiving_accounts` (`id`),
  CONSTRAINT `fk_cledger_user` FOREIGN KEY (`acting_user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_cledger_refers` FOREIGN KEY (`refers_to_id`) REFERENCES `consignment_ledger` (`id`),

  CONSTRAINT `ck_cledger_amount` CHECK (`amount` > 0),
  -- Only a payment moves by a method, and cash belongs to no account.
  CONSTRAINT `ck_cledger_method` CHECK (
    (`kind` IN ('payment_reported','payment_confirmed','payment_corrected')
      OR (`method` IS NULL AND `receiving_account_id` IS NULL))
    AND (`method` <> 'cash' OR `receiving_account_id` IS NULL)
  ),
  -- Forgiveness and correction state why.
  CONSTRAINT `ck_cledger_reason` CHECK (
    `kind` NOT IN ('forgiven','payment_corrected') OR TRIM(COALESCE(`reason`, '')) <> ''
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only, enforced where it cannot be bypassed. A correction is another
-- row, exactly as Milestone B established for every other financial record.
-- The migrator is exempt so `docs/22` restore still works.
DROP TRIGGER IF EXISTS `consignment_ledger_block_update`;
CREATE TRIGGER `consignment_ledger_block_update`
BEFORE UPDATE ON `consignment_ledger`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'The consignment ledger is append-only: add a correcting entry instead';
  END IF;
END;

DROP TRIGGER IF EXISTS `consignment_ledger_block_delete`;
CREATE TRIGGER `consignment_ledger_block_delete`
BEFORE DELETE ON `consignment_ledger`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'The consignment ledger is append-only: a ledger row is never deleted';
  END IF;
END;

-- 7. The unit gains a custody state ------------------------------------------
-- `transferred_out` is INTERNAL — it means the unit left this branch for
-- another branch of the same company. A consigned phone is legally still ours
-- and must stay distinguishable from one that has gone.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'units'
      AND column_name = 'status'
      AND column_type NOT LIKE '%consigned_out%') = 1,
  "ALTER TABLE `units` MODIFY COLUMN `status`
     ENUM('in_stock','reserved','sold','returned','faulty','in_transit',
          'transferred_out','consigned_out') NOT NULL DEFAULT 'in_stock'",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- 8. Permissions --------------------------------------------------------------
-- Narrow keys, because consignment mixes operational acts (send a phone,
-- receive one) with company-level authority (trust another shop, forgive a
-- debt). Granting them together would let whoever ships stock also decide who
-- the business deals with.
INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT * FROM (
  SELECT UNHEX(REPLACE(UUID(), '-', '')) AS id, 'connection.manage' AS k, 'Connect to, block or unblock another store' AS l
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'consignment.view', 'See consignments'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'consignment.request', 'Propose sending stock on consignment'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'consignment.review', 'Accept, counter or dispute a consignment proposal'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'consignment.custody.send', 'Record handing a consigned phone over'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'consignment.custody.receive', 'Confirm physically receiving a consigned phone'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'consignment.sell', 'Sell a phone held on consignment'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'consignment.payment.report', 'Report a consignment payment'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'consignment.payment.confirm', 'Confirm a consignment payment arrived'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'consignment.return.confirm', 'Confirm a consigned phone came back'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'consignment.forgive', 'Forgive part or all of a consignment balance'
) AS want
WHERE NOT EXISTS (SELECT 1 FROM `permissions` p WHERE p.`key` = want.k);

-- Owner: everything above.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` IN (
  'connection.manage','consignment.view','consignment.request','consignment.review',
  'consignment.custody.send','consignment.custody.receive','consignment.sell',
  'consignment.payment.report','consignment.payment.confirm',
  'consignment.return.confirm','consignment.forgive')
WHERE r.`key` = 'owner'
  AND NOT EXISTS (SELECT 1 FROM `role_permissions` rp
                  WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`);

/*
 * Store Manager: operates the relationship, never decides it.
 *
 * Deliberately WITHOUT `connection.manage` — choosing which businesses this
 * shop deals with is company-level trust, not branch operation. Deliberately
 * WITHOUT `consignment.forgive` — writing off money owed to the business is the
 * Owner's call everywhere else in this system and stays so here.
 */
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` IN (
  'consignment.view','consignment.request','consignment.review',
  'consignment.custody.send','consignment.custody.receive','consignment.sell',
  'consignment.payment.report','consignment.return.confirm')
WHERE r.`key` = 'store_manager'
  AND NOT EXISTS (SELECT 1 FROM `role_permissions` rp
                  WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`);

/*
 * Store Employee: the two physical acts and nothing else.
 *
 * They hand a phone over and they confirm one arrived — the same reasoning that
 * gives them `transfer.ship` and `transfer.receive`. They deliberately do NOT
 * get `consignment.request` or `.review`: agreeing what another business pays
 * us is not an operational act, and "employees can receive ordinary stock" is
 * not a reason to hand them that.
 */
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` IN (
  'consignment.view','consignment.custody.send','consignment.custody.receive')
WHERE r.`key` = 'store_employee'
  AND NOT EXISTS (SELECT 1 FROM `role_permissions` rp
                  WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`);

-- Reverse SQL (not executed):
--   DROP TRIGGER IF EXISTS `consignment_ledger_block_update`;
--   DROP TRIGGER IF EXISTS `consignment_ledger_block_delete`;
--   DROP TABLE IF EXISTS `consignment_ledger`;
--   DROP TABLE IF EXISTS `consignment_lines`;
--   DROP TABLE IF EXISTS `consignments`;
--   DROP TABLE IF EXISTS `counterparties`;
--   DROP TABLE IF EXISTS `store_connections`;
--   ALTER TABLE `units` MODIFY COLUMN `status`
--     ENUM('in_stock','reserved','sold','returned','faulty','in_transit','transferred_out')
--     NOT NULL DEFAULT 'in_stock';
--   ALTER TABLE `companies` DROP INDEX `ix_companies_discovery`,
--     DROP COLUMN `is_discoverable`, DROP COLUMN `city`,
--     DROP COLUMN `logo_ref`, DROP COLUMN `public_phone`;
--   DELETE rp FROM `role_permissions` rp JOIN `permissions` p ON p.`id` = rp.`permission_id`
--     WHERE p.`key` LIKE 'consignment.%' OR p.`key` = 'connection.manage';
--   DELETE FROM `permissions` WHERE `key` LIKE 'consignment.%' OR `key` = 'connection.manage';
