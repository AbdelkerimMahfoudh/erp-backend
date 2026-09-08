-- ===========================================================================
-- 0064 — a retry must not deliver the goods twice.
--
-- The defect
-- ----------
-- Quick "Add Stock" for quantity-tracked products had no event record at all.
-- `stock_items` holds a BALANCE — "this branch has 40 cables" — and never the
-- receipts that produced it. So when the response to "receive 15" was lost to a
-- dropped connection and the employee tapped the button again, the second
-- request was indistinguishable from a genuine second delivery. Stock went to
-- 70, the weighted-average cost absorbed the phantom goods, and nothing in the
-- database recorded that it had happened.
--
-- Serialized intake never had this problem, and the reason is instructive: a
-- phone's `Unit` row IS the event, and its IMEI is a natural key. The retry
-- collides on the unique index and is refused for free. Quantity goods have no
-- such key — one cable is not distinguishable from the next — so the key has to
-- be supplied by the client, before the request, and stored.
--
-- The fix
-- -------
-- One new table recording each receipt, with the same `client_uuid` +
-- `client_request_hash` pair that purchases, transfers and financial
-- corrections have used since 0013. Same key + same payload replays the
-- original answer; same key + a DIFFERENT payload is a conflict, because that
-- is not a retry — it is a second receipt wearing the first one's identity.
--
-- The unique index is what enforces this, not an application read: two retries
-- racing each other both find nothing, both insert, and exactly one survives.
-- A `SELECT`-then-`INSERT` would let both through.
--
-- Existing data
-- -------------
-- Purely additive. No column is altered, no row is created, renamed or
-- deleted, and nothing about existing stock balances changes. Receipts taken
-- before this migration simply have no record here — the table starts empty and
-- describes the future, which is the honest thing for it to say. It is NOT
-- back-filled from `stock_items`, because a balance cannot be decomposed into
-- the receipts that made it.
--
-- `quantity` carries a CHECK rather than only a DTO rule, matching the CHECK on
-- `stock_items.quantity` from 0002: a receipt of zero or minus five is not a
-- correction, it is a bug, and the database is the last place that can still
-- say so.
-- ===========================================================================

CREATE TABLE `stock_receipts` (
  `id`                  BINARY(16)     NOT NULL,
  `company_id`          BINARY(16)     NOT NULL,
  `branch_id`           BINARY(16)     NOT NULL,
  `product_id`          BINARY(16)     NOT NULL,
  `user_id`             BINARY(16)     NULL,
  `client_uuid`         BINARY(16)     NULL,
  `client_request_hash` CHAR(64)       NULL,
  `quantity`            INT            NOT NULL,
  `unit_cost`           DECIMAL(14, 2) NOT NULL,
  `created_at`          DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  PRIMARY KEY (`id`),

  -- The idempotency key. NULL is allowed and repeatable: MySQL unique indexes
  -- ignore NULLs, so a caller that sends no key simply gets no retry
  -- protection, exactly as before this migration.
  UNIQUE KEY `ux_stock_receipts_client_uuid` (`company_id`, `client_uuid`),

  KEY `ix_stock_receipts_branch_date` (`company_id`, `branch_id`, `created_at`),
  KEY `ix_stock_receipts_product` (`product_id`),

  CONSTRAINT `fk_stock_receipts_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_stock_receipts_branch`  FOREIGN KEY (`branch_id`)  REFERENCES `branches` (`id`),
  CONSTRAINT `fk_stock_receipts_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`),
  CONSTRAINT `fk_stock_receipts_user`    FOREIGN KEY (`user_id`)    REFERENCES `users` (`id`),

  CONSTRAINT `ck_stock_receipts_quantity_positive` CHECK (`quantity` >= 1)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
