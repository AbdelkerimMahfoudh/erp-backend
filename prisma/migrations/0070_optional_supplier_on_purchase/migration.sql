-- 0070 — a purchase may name no supplier, when it is settled in full.
--
-- WHY
-- The everyday case in this shop is buying a handset from whoever walks in with
-- it and paying on the spot. There is no trading partner to record. Until now
-- `purchases.supplier_id` was NOT NULL, so the only ways to book that purchase
-- were to invent an "Unknown supplier" — a fictional counterparty in the
-- payables ledger, which is worse than the problem — or not to book it at all.
--
-- WHAT THIS DOES NOT CHANGE
-- Nothing is dropped, nothing is backfilled and no existing row moves. Both
-- columns keep their foreign keys: MySQL enforces a FK only on a non-NULL
-- value, so every named supplier is still guaranteed to exist. Existing
-- purchases keep their supplier, and every payable, settlement and allocation
-- keyed on a concrete supplier behaves exactly as before — those queries filter
-- by supplier id, so a NULL-supplier purchase is simply not a payable, which is
-- correct: a purchase paid in full owes nobody.
--
-- THE RULE THAT MAKES THIS SAFE lives in the service, not here: a purchase with
-- no supplier must be paid in full. A column constraint cannot express it,
-- because `amount_paid` and `total` are both on this row but the business rule
-- is "no payee ⇒ no outstanding balance", and a CHECK would also have to hold
-- for historical rows written before it existed.

ALTER TABLE `purchases`
  MODIFY COLUMN `supplier_id` BINARY(16) NULL;

-- Money genuinely left the till for a walk-in purchase, and that record must
-- survive without a trading partner to attribute it to. Dropping the payment
-- row instead would lose the fact that the shop paid at all.
ALTER TABLE `supplier_payments`
  MODIFY COLUMN `supplier_id` BINARY(16) NULL;
