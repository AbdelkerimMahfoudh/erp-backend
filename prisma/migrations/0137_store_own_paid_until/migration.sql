-- 0137 (owner, 2026-11-12): an additional store gets no free trial and opens when its own payment is approved, wherever
-- the Owner asked for it (the app or the portal). Its own paid month covers it: the business's billing period does not
-- charge its store fee in a period that starts before this instant; from then on it renews with the business.
-- Set only when a store opens with its own paid month. Additive; rollback: drop the column.
ALTER TABLE seat_allocations ADD COLUMN own_paid_until DATETIME(6) NULL AFTER free_until_at;
