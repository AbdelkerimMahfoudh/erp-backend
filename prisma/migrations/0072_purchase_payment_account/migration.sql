-- 0072 — an ordinary purchase records WHERE its full payment came from.
--
-- WHY
-- First release: Suppliers are postponed, and every ordinary purchase is paid in
-- full at the moment it is received. The payment is written to
-- `supplier_payments` (the historical name of the purchase-payment record; the
-- supplier column has been nullable since 0070). A non-cash purchase must name
-- the active receiving account the money left from — exactly as a sale names the
-- account it arrived in — or it cannot be reconciled.
--
-- The table had no account column, so the only honest options were refusing
-- non-cash purchases or storing money with no account. This adds the account and
-- its label, frozen at payment time so a later rename cannot retitle history.
--
-- WHAT THIS DOES NOT CHANGE
-- Nothing is dropped, backfilled or renamed. Existing rows keep NULL (cash, or
-- written before this column existed). Supplier, settlement and purchase history
-- is untouched.

ALTER TABLE `supplier_payments`
  ADD COLUMN `receiving_account_id` BINARY(16) NULL AFTER `method`,
  ADD COLUMN `account_label_snapshot` VARCHAR(80) NULL AFTER `receiving_account_id`,
  ADD KEY `ix_supplier_payments_account` (`company_id`, `receiving_account_id`),
  ADD CONSTRAINT `fk_supplier_payments_account`
    FOREIGN KEY (`receiving_account_id`) REFERENCES `receiving_accounts` (`id`);
