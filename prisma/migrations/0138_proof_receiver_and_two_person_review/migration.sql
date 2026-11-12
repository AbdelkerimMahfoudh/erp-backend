-- 0138 (owner, 2026-11-12): where the customer sent the money, and a two-person review of each payment proof.
-- receive_service / receive_number: the service and receiving number the Owner chose (shown in the admin review).
-- opened_*: the first administrator opened the purchased access while the payment is verified — who, when, on which
-- revision, and what it changed (the business's paid-until before and after), so a refusal takes back only that.
-- confirmed_by: the second, different administrator who confirmed the deposit.
-- alerted_at / overdue_alerted_at: the administrators' WhatsApp alerts, each sent once per proof.
-- Additive; rollback: drop the columns.
ALTER TABLE payment_proofs
  ADD COLUMN receive_service VARCHAR(16) NULL AFTER payer_phone,
  ADD COLUMN receive_number VARCHAR(16) NULL AFTER receive_service,
  ADD COLUMN opened_by VARCHAR(160) NULL AFTER decided_at,
  ADD COLUMN opened_at DATETIME(6) NULL AFTER opened_by,
  ADD COLUMN opened_revision INT UNSIGNED NULL AFTER opened_at,
  ADD COLUMN open_changes JSON NULL AFTER opened_revision,
  ADD COLUMN confirmed_by VARCHAR(160) NULL AFTER open_changes,
  ADD COLUMN alerted_at DATETIME(6) NULL AFTER confirmed_by,
  ADD COLUMN overdue_alerted_at DATETIME(6) NULL AFTER alerted_at,
  ADD INDEX ix_payment_proofs_opened (status, opened_at);
