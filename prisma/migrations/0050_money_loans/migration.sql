-- 0050 — money loans
--
-- ## Why this is not a consignment with no phone
--
-- A consignment carries custody: something physical moves, is held, is sold or
-- comes back, and its record needs shipment, condition, disposition and return.
-- A loan has none of that. Modelling one as "a consignment with no unit" would
-- put custody states on a record that can never have custody — the kind of
-- shortcut that reads as clever and becomes unmaintainable the first time
-- somebody asks why a loan can be `return_in_transit`.
--
-- What IS reused, deliberately and by design rather than retrofit:
--
--   `counterparties` — already carries `manual_person` and `employee` kinds,
--   added in 0049 for exactly this. A loan and a consignment against the same
--   shop share one counterparty, so "who owes us money" is one list.
--
--   The immutable ledger shape, report → confirm → correct, and forgiveness
--   with a mandatory reason. Those rules were argued out in Milestones B, E and
--   H and are not re-argued here.
--
-- ## Direction is data, never a sign
--
-- `direction` is an explicit column. A negative amount is ambiguous the moment
-- somebody corrects a payment, and a sign flip is a silent reversal of who owes
-- whom — which in a two-party money record is the worst possible silent change.
--
-- The direction is stored relative to `company_id`, the company that created
-- the row. The counterparty reads the same row with the direction inverted,
-- which is why there is one row and not two: two rows can disagree.
--
-- Rerun-safe: guarded.

CREATE TABLE IF NOT EXISTS `loans` (
  `id`         BINARY(16) NOT NULL,
  /*
   * The company that created this record. Like `consignments`, a loan between
   * two application companies is CROSS-TENANT and cannot be scoped
   * automatically — every read goes through the same
   * `source = me OR counterparty = me` filter.
   */
  `company_id` BINARY(16) NOT NULL,
  `branch_id`  BINARY(16) NULL,

  `counterparty_id` BINARY(16) NOT NULL,
  /* Set only when the counterparty is a company on this platform. */
  `counterparty_company_id` BINARY(16) NULL,
  `connection_id` BINARY(16) NULL,

  /*
   * Relative to `company_id`. The counterparty sees the same row inverted.
   * Never inferred from the sign of an amount.
   */
  `direction` ENUM('they_owe_us','we_owe_them') NOT NULL,

  `status` ENUM(
    'proposed','counter_proposed','disputed',
    'accepted','partially_paid','payment_awaiting_confirmation',
    'settled','forgiven_settled','cancelled'
  ) NOT NULL DEFAULT 'proposed',

  /*
   * The negotiation. `principal` is what both sides agreed and becomes
   * IMMUTABLE at acceptance — after that the amount cannot move under either
   * party, which is the whole point of asking the recipient to accept.
   */
  `proposed_amount` DECIMAL(14,2) NOT NULL,
  `counter_amount`  DECIMAL(14,2) NULL,
  `principal`       DECIMAL(14,2) NULL,

  `note`           VARCHAR(255) NULL,
  `dispute_reason` VARCHAR(255) NULL,

  /*
   * Which COMPANY made the offer currently on the table, so "you cannot accept
   * your own offer" is answerable from the row. For a manual counterparty this
   * is always the owning company, and acceptance is recorded by the Owner on
   * the other party's behalf.
   */
  `proposed_by_company_id` BINARY(16) NOT NULL,
  `proposed_by_id` BINARY(16) NULL,
  `decided_by_id`  BINARY(16) NULL,
  `decided_at`     DATETIME(6) NULL,
  `accepted_at`    DATETIME(6) NULL,
  `settled_at`     DATETIME(6) NULL,

  `client_uuid` BINARY(16) NULL,
  `version`     INT NOT NULL DEFAULT 0,
  `created_at`  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_loans_client_uuid` (`company_id`, `client_uuid`),
  KEY `ix_loans_company` (`company_id`, `status`, `created_at`),
  KEY `ix_loans_counterparty_company` (`counterparty_company_id`, `status`),
  KEY `ix_loans_counterparty` (`counterparty_id`),
  KEY `ix_loans_branch` (`branch_id`),
  KEY `ix_loans_connection` (`connection_id`),
  KEY `ix_loans_proposed_by` (`proposed_by_id`),
  KEY `ix_loans_decided_by` (`decided_by_id`),
  CONSTRAINT `fk_loans_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_loans_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_loans_cp` FOREIGN KEY (`counterparty_id`) REFERENCES `counterparties` (`id`),
  CONSTRAINT `fk_loans_cp_company` FOREIGN KEY (`counterparty_company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_loans_connection` FOREIGN KEY (`connection_id`) REFERENCES `store_connections` (`id`),
  CONSTRAINT `fk_loans_proposed_company` FOREIGN KEY (`proposed_by_company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_loans_proposed_by` FOREIGN KEY (`proposed_by_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_loans_decided_by` FOREIGN KEY (`decided_by_id`) REFERENCES `users` (`id`),

  -- A company cannot lend to itself.
  CONSTRAINT `ck_loans_not_self` CHECK (`counterparty_company_id` IS NULL
                                        OR `counterparty_company_id` <> `company_id`),
  -- Amounts are positive when present. A loan of nothing is not a loan.
  CONSTRAINT `ck_loans_amounts` CHECK (
    `proposed_amount` > 0
    AND (`counter_amount` IS NULL OR `counter_amount` > 0)
    AND (`principal` IS NULL OR `principal` > 0)
  ),
  -- A dispute states its reason.
  CONSTRAINT `ck_loans_dispute` CHECK (
    `status` <> 'disputed' OR TRIM(COALESCE(`dispute_reason`, '')) <> ''
  ),
  /*
   * An accepted loan HAS a principal, and an unaccepted one does not. This is
   * what makes "the principal is immutable once accepted" enforceable rather
   * than merely intended: there is nothing to freeze before acceptance, and
   * nothing may exist without it after.
   */
  CONSTRAINT `ck_loans_principal` CHECK (
    (`status` IN ('proposed','counter_proposed','disputed','cancelled') AND `principal` IS NULL)
    OR (`status` NOT IN ('proposed','counter_proposed','disputed','cancelled')
        AND `principal` IS NOT NULL AND `accepted_at` IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The money, append-only ------------------------------------------------------
-- What remains is DERIVED from these rows and stored nowhere, the same rule the
-- employee debt ledger (0045) and the consignment ledger (0049) follow.
CREATE TABLE IF NOT EXISTS `loan_ledger` (
  `id`      BINARY(16) NOT NULL,
  `loan_id` BINARY(16) NOT NULL,
  /* Both sides, so either party reads its own ledger without a join. */
  `company_id`              BINARY(16) NOT NULL,
  `counterparty_company_id` BINARY(16) NULL,

  /*
   *   `principal_accepted` — both sides agreed. Sets what is owed.
   *   `payment_reported`   — money says it moved. Changes NOTHING until confirmed.
   *   `payment_confirmed`  — the creditor agrees it arrived.
   *   `payment_corrected`  — a confirmed payment reversed; the debt returns.
   *   `forgiven`           — the creditor waived part or all. Not cash.
   *   `settled`            — closed with nothing outstanding.
   */
  `kind` ENUM('principal_accepted','payment_reported','payment_confirmed',
              'payment_corrected','forgiven','settled') NOT NULL,

  -- Always a positive magnitude; `kind` carries the direction.
  `amount` DECIMAL(14,2) NOT NULL,

  `method` ENUM('cash','account') NULL,
  `receiving_account_id` BINARY(16) NULL,
  -- Frozen: renaming an account later must not retitle a movement.
  `account_label_snapshot` VARCHAR(80) NULL,
  `reference` VARCHAR(120) NULL,
  /*
   * A photo or document reference. **Not proof.** No provider is contacted and
   * nothing is verified — the screens must never present it as confirmation.
   */
  `evidence_ref` VARCHAR(512) NULL,

  -- Mandatory for forgiveness and correction.
  `reason` VARCHAR(255) NULL,
  `note`   VARCHAR(255) NULL,

  -- Which side wrote this, so report and confirm stay distinguishable.
  `acting_company_id` BINARY(16) NOT NULL,
  `acting_user_id`    BINARY(16) NULL,
  `entry_date` DATE NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `client_uuid` BINARY(16) NULL,
  -- The reported entry a confirmation or correction answers.
  `refers_to_id` BINARY(16) NULL,

  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_lledger_client_uuid` (`acting_company_id`, `client_uuid`),
  KEY `ix_lledger_loan` (`loan_id`, `kind`),
  KEY `ix_lledger_company` (`company_id`, `entry_date`),
  KEY `ix_lledger_cp_company` (`counterparty_company_id`, `entry_date`),
  KEY `ix_lledger_account` (`receiving_account_id`),
  KEY `ix_lledger_user` (`acting_user_id`),
  KEY `ix_lledger_refers` (`refers_to_id`),
  CONSTRAINT `fk_lledger_loan` FOREIGN KEY (`loan_id`) REFERENCES `loans` (`id`),
  CONSTRAINT `fk_lledger_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_lledger_cp_company` FOREIGN KEY (`counterparty_company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_lledger_acting` FOREIGN KEY (`acting_company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_lledger_account` FOREIGN KEY (`receiving_account_id`) REFERENCES `receiving_accounts` (`id`),
  CONSTRAINT `fk_lledger_user` FOREIGN KEY (`acting_user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_lledger_refers` FOREIGN KEY (`refers_to_id`) REFERENCES `loan_ledger` (`id`),

  CONSTRAINT `ck_lledger_amount` CHECK (`amount` > 0),
  -- Only a payment moves by a method, and cash belongs to no account.
  CONSTRAINT `ck_lledger_method` CHECK (
    (`kind` IN ('payment_reported','payment_confirmed','payment_corrected')
      OR (`method` IS NULL AND `receiving_account_id` IS NULL))
    AND (`method` <> 'cash' OR `receiving_account_id` IS NULL)
  ),
  CONSTRAINT `ck_lledger_reason` CHECK (
    `kind` NOT IN ('forgiven','payment_corrected') OR TRIM(COALESCE(`reason`, '')) <> ''
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only where it cannot be bypassed. A correction is another row.
-- The migrator is exempt so `docs/22` restore still works.
DROP TRIGGER IF EXISTS `loan_ledger_block_update`;
CREATE TRIGGER `loan_ledger_block_update`
BEFORE UPDATE ON `loan_ledger`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'The loan ledger is append-only: add a correcting entry instead';
  END IF;
END;

DROP TRIGGER IF EXISTS `loan_ledger_block_delete`;
CREATE TRIGGER `loan_ledger_block_delete`
BEFORE DELETE ON `loan_ledger`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'The loan ledger is append-only: a ledger row is never deleted';
  END IF;
END;

-- Permissions ------------------------------------------------------------------
-- Four keys. A loan is money with no goods attached, so the split follows the
-- money rules the rest of the system uses rather than the stock rules: reporting
-- a payment is operational, confirming one and writing one off are not.
INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT * FROM (
  SELECT UNHEX(REPLACE(UUID(), '-', '')) AS id, 'loan.view' AS k, 'See money owed and lent' AS l
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'loan.manage', 'Propose, accept, counter or dispute a loan'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'loan.payment.report', 'Report a loan payment'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'loan.payment.confirm', 'Confirm a loan payment arrived'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'loan.forgive', 'Forgive part or all of a loan'
) AS want
WHERE NOT EXISTS (SELECT 1 FROM `permissions` p WHERE p.`key` = want.k);

-- Owner: everything.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` IN (
  'loan.view','loan.manage','loan.payment.report','loan.payment.confirm','loan.forgive')
WHERE r.`key` = 'owner'
  AND NOT EXISTS (SELECT 1 FROM `role_permissions` rp
                  WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`);

/*
 * Store Manager: sees the balances and reports a payment, and decides nothing.
 *
 * Deliberately WITHOUT `loan.manage`: agreeing that this business owes another
 * business money is not a branch decision. Deliberately WITHOUT
 * `loan.payment.confirm` and `loan.forgive`, for the same reason every other
 * money workflow reserves those for the Owner.
 */
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` IN ('loan.view', 'loan.payment.report')
WHERE r.`key` = 'store_manager'
  AND NOT EXISTS (SELECT 1 FROM `role_permissions` rp
                  WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`);

/*
 * Store Employee: nothing at all.
 *
 * An employee has no reason to see what the business owes or is owed, and a
 * loan can be against an employee — showing them the ledger would show them
 * their colleagues' debts.
 */

-- Reverse SQL (not executed):
--   DROP TRIGGER IF EXISTS `loan_ledger_block_update`;
--   DROP TRIGGER IF EXISTS `loan_ledger_block_delete`;
--   DROP TABLE IF EXISTS `loan_ledger`;
--   DROP TABLE IF EXISTS `loans`;
--   DELETE rp FROM `role_permissions` rp JOIN `permissions` p ON p.`id` = rp.`permission_id`
--     WHERE p.`key` LIKE 'loan.%';
--   DELETE FROM `permissions` WHERE `key` LIKE 'loan.%';
