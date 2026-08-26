-- ===========================================================================
-- 0059 — the permission catalogue, as reference data.
--
-- **Reference data only. No schema change, and no change to role authority.**
-- It inserts catalogue ROWS; it grants nothing. `role_permissions` is not
-- touched, no tenant, user, branch, subscription or demo record is created, and
-- no existing row is modified.
--
-- Why this migration exists
-- -------------------------
-- The catalogue is reference data every environment needs, and until now NO
-- migration created it. The base keys — `sale.create`, `report.view`,
-- `user.manage` and 14 others — existed only in `prisma/seed.ts`, which also
-- seeds the DEMO COMPANY and therefore never runs against staging or a real
-- deployment. A database built by `prisma migrate deploy` alone held 44 of the
-- 61 keys.
--
-- The demo seed concealed it precisely because it did both jobs at once: every
-- environment anybody looked at had run the seed, so the catalogue was always
-- complete there. Staging — the first environment deliberately built WITHOUT
-- the demo company — was also the first to show the gap.
--
-- Semantics
-- ---------
--   * clean install: inserts all 61 rows;
--   * upgrade from the 44-key state: inserts exactly the 17 missing rows;
--   * already complete: inserts nothing and changes nothing.
--
-- `NOT EXISTS` rather than `INSERT IGNORE` or `REPLACE`, deliberately. IGNORE
-- would also swallow a real error — a truncated label under strict mode, a
-- broken constraint — and leave the catalogue quietly short, which is the exact
-- class of silent failure this migration exists to end. REPLACE would delete
-- and reinsert, discarding ids that `role_permissions` rows point at.
--
-- Provenance
-- ----------
-- Generated from `src/rbac/role-permissions.ts` by
-- `scripts/generate-catalogue-migration.ts`. It is an immutable historical
-- snapshot, not a second source of authority: runtime code never reads this
-- file, and `permission-catalogue.spec.ts` fails the build if the two drift.
--
-- **A future permission needs a FUTURE migration.** Never edit this one — every
-- database that has already applied it would silently stop matching the file
-- that claims to describe it.
-- ===========================================================================

INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT * FROM (
  SELECT UNHEX(REPLACE(UUID(), '-', '')) AS id, 'sale.create' AS k, 'Create sales' AS l
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'sale.return', 'Process returns'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'sale.view', 'View sales history'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'return.policy.override', 'Change the return policy at sale time'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'return.view', 'View returns'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'return.request', 'Raise a return request'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'return.review', 'Investigate and assign responsibility'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'return.approve', 'Approve a return (creates a refund obligation)'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'return.reject', 'Reject a return'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'return.exception', 'Approve outside policy, or against customer damage'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'refund.report', 'Report that a refund was handed to the customer'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'refund.confirm', 'Confirm a refund was actually paid'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'supplier.payment.report', 'Report that a supplier was paid'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'supplier.payment.confirm', 'Confirm a supplier payment was actually made'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'financial.correction.request', 'Request a correction to a confirmed payment'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'financial.correction.approve', 'Approve a correction to a confirmed payment'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'cost.view', 'View cost & profit'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'discount.apply', 'Apply discounts (within limit)'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'discount.override', 'Override discount limits'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'unit.add', 'Add inventory units'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'unit.transfer', 'Transfer stock between branches'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'import.run', 'Run Excel/CSV inventory import'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'purchase.manage', 'Manage purchases'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'supplier.manage', 'Manage suppliers'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'expense.submit', 'Submit an expense for review'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'expense.review', 'Confirm or reject a submitted expense'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'expense.manage', 'Manage expenses'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'closing.count', 'Enter an end-of-day count'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'closing.perform', 'Perform & lock daily closing'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'debt.manage', 'Assign, collect or forgive a cash discrepancy'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'goal.manage', 'Set and archive goals'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'connection.manage', 'Connect to, block or unblock another store'
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
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'loan.view', 'See money owed and lent'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'loan.manage', 'Propose, accept, counter or dispute a loan'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'loan.payment.report', 'Report a loan payment'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'loan.payment.confirm', 'Confirm a loan payment arrived'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'loan.forgive', 'Forgive part or all of a loan'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'report.view', 'View reports'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'branch.manage', 'Manage branches'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'user.manage', 'Manage users'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'settings.manage', 'Manage settings'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'integrations.manage', 'Manage integrations (WhatsApp, FCM)'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'price.edit', 'Edit item prices'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'catalog.manage', 'Manage the product catalog'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'transfer.view', 'View stock transfers'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'transfer.request', 'Request a stock transfer'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'transfer.approve', 'Approve or reject a transfer request'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'transfer.ship', 'Ship an approved transfer'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'transfer.receive', 'Receive a transfer at the destination'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'transfer.cancel', 'Cancel any transfer before shipment'
  UNION ALL SELECT UNHEX(REPLACE(UUID(), '-', '')), 'transfer.cancel_own', 'Withdraw your own pending request'
) AS want
WHERE NOT EXISTS (SELECT 1 FROM `permissions` p WHERE p.`key` = want.k);
