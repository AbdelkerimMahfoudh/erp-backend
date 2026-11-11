-- 0136 (owner, 2026-11-11): a payment proof keeps the name its file was sent with (made safe, its extension matching the
-- type sniffed from its bytes), so it downloads as something a computer opens. Older proofs have none: they are served
-- under a name built from their date and sniffed type. Additive; rollback: drop the column.
ALTER TABLE payment_proofs ADD COLUMN file_name VARCHAR(160) NULL AFTER content_type;
