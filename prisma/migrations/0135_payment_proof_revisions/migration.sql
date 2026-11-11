-- 0135 (owner, 2026-11-11): the Owner pays a waiting store from the portal with the number they paid from and the
-- screenshot, and may correct either until the administrator decides. Each correction raises the proof's revision; an
-- approval or a refusal names the revision it was decided on, so a decision on an older one is refused.
-- Additive: two nullable columns and one with a default. Rollback: drop the three columns (no other table reads them).
ALTER TABLE payment_proofs
  ADD COLUMN payer_phone VARCHAR(32) NULL AFTER reference,
  ADD COLUMN revision INT UNSIGNED NOT NULL DEFAULT 1 AFTER payer_phone,
  ADD COLUMN revised_at DATETIME(6) NULL AFTER revision;
