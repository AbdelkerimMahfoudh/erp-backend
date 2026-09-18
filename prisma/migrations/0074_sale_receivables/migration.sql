-- 0074 — a sale can be paid over time, and says who owes the rest.
--
-- WHY
-- A sale already knew what it was worth (`total`), what had been paid
-- (`amount_paid`), what was left (`balance_due`) and its status. It could not
-- record a SECOND payment honestly: a payment row had no idea who recorded it,
-- whether it was taken at the till or collected later, what reference the
-- customer quoted, or any key to stop a retried request recording it twice.
-- And a balance could only be owed by a customer — never by a partner store,
-- although a store buying a phone on credit is an everyday sale.
--
-- A later collection must be a movement of money on the day it ARRIVES, not a
-- second sale. Everything here serves that: the payment row carries its own
-- date (`paid_at`, which already existed), its kind, its recorder and its key.
-- Revenue and profit are untouched — they come from `sale_items` on the sale's
-- own day, and nothing in this migration writes to either.
--
-- WHAT THIS ADDS
-- payments
--   kind                 `at_sale` for money taken with the sale, `collection`
--                        for money received later against its balance.
--   recorded_by_id       Who confirmed the money arrived. Backfilled from the
--                        sale's seller for every existing row, which is exactly
--                        who took it: every existing payment was taken at the
--                        till, in the same second as its sale (verified before
--                        this migration: 7 of 7, 0 seconds apart).
--   client_uuid          Idempotency key for a later collection. Unique per
--   client_request_hash  company; the hash binds the key to its payload, so a
--                        replay answers and a changed payload is refused.
--   reference, note      Optional, the shop's own words.
--   CHECK amount > 0     A payment is money received. Zero or negative is not.
--
-- sales
--   counterparty_id      A partner store — connected or manual — owing the
--                        balance. Reuses `counterparties`, the single record of
--                        who the shop deals with, rather than a second list.
--   CHECK                Neither the paid amount nor the balance may be
--                        negative, so an overpayment cannot be stored.
--
-- expenses
--   receipt_key          Where an optional receipt photo is stored.
--
-- WHAT THIS DOES NOT DO
-- No row is deleted or renamed. No amount changes. The one-debtor rule (a
-- balance owed by a customer OR a store, never both) is enforced by the service:
-- MySQL refuses a CHECK on `customer_id` because its foreign key is
-- ON DELETE SET NULL.

ALTER TABLE `payments`
  ADD COLUMN `kind` ENUM('at_sale', 'collection') NOT NULL DEFAULT 'at_sale' AFTER `sale_id`,
  ADD COLUMN `recorded_by_id` BINARY(16) NULL AFTER `paid_at`,
  ADD COLUMN `client_uuid` BINARY(16) NULL AFTER `recorded_by_id`,
  ADD COLUMN `client_request_hash` CHAR(64) NULL AFTER `client_uuid`,
  ADD COLUMN `reference` VARCHAR(80) NULL AFTER `client_request_hash`,
  ADD COLUMN `note` VARCHAR(255) NULL AFTER `reference`;

UPDATE `payments` p
  JOIN `sales` s ON s.id = p.sale_id
   SET p.recorded_by_id = s.user_id
 WHERE p.recorded_by_id IS NULL;

ALTER TABLE `payments`
  ADD UNIQUE KEY `ux_payments_client_uuid` (`company_id`, `client_uuid`),
  ADD KEY `ix_payments_paid_at` (`company_id`, `paid_at`),
  ADD KEY `ix_payments_recorded_by` (`recorded_by_id`),
  ADD CONSTRAINT `fk_payments_recorded_by`
    FOREIGN KEY (`recorded_by_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `payments_amount_pos_chk` CHECK (`amount` > 0);

ALTER TABLE `sales`
  ADD COLUMN `counterparty_id` BINARY(16) NULL AFTER `customer_id`,
  ADD KEY `ix_sales_counterparty` (`counterparty_id`),
  ADD KEY `ix_sales_balance` (`company_id`, `branch_id`, `balance_due`),
  ADD CONSTRAINT `fk_sales_counterparty`
    FOREIGN KEY (`counterparty_id`) REFERENCES `counterparties` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `sales_balance_nonneg_chk` CHECK (`amount_paid` >= 0 AND `balance_due` >= 0);

ALTER TABLE `expenses`
  ADD COLUMN `receipt_key` VARCHAR(255) NULL AFTER `reference`;
