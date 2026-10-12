-- 0093 — delivery boundaries (correction phase, 2026-10-12; docs/64, docs/24).
--
-- 1. messaging_delivery_proofs: one row per real send an operator makes to prove a channel on this deployment
--    (`npm run whatsapp:prove`). `delivered_at` is set only by the signed delivery webhook. A production
--    deployment sends no WhatsApp message until every language (en, fr, ar) has a delivered proof.
-- 2. contact_verifications: what delivery actually did with each code — the provider, its message id, the
--    state and a short provider-neutral detail — and the version of the code hash (1 = the earlier unkeyed
--    SHA-256, 2 = HMAC-SHA256 under OTP_PEPPER). Existing rows keep version 1; nothing is rehashed.
--
-- Additive only: no existing row changes meaning. Reverse:
--   DROP TABLE messaging_delivery_proofs;
--   ALTER TABLE contact_verifications DROP COLUMN hash_version, DROP COLUMN delivery_detail,
--     DROP COLUMN provider_message_id, DROP COLUMN delivery_provider, DROP COLUMN delivery_state;

CREATE TABLE messaging_delivery_proofs (
  id BINARY(16) NOT NULL,
  channel VARCHAR(20) NOT NULL,
  provider VARCHAR(40) NOT NULL,
  template VARCHAR(60) NOT NULL,
  language VARCHAR(5) NOT NULL,
  destination_masked VARCHAR(40) NOT NULL,
  provider_message_id VARCHAR(191) NULL,
  accepted_at DATETIME(6) NULL,
  delivered_at DATETIME(6) NULL,
  failure_detail VARCHAR(200) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY ux_delivery_proof_message (provider, provider_message_id),
  KEY ix_delivery_proof_channel (channel, language, delivered_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE contact_verifications
  ADD COLUMN delivery_state ENUM('not_sent', 'accepted', 'outbox', 'failed') NOT NULL DEFAULT 'not_sent' AFTER attempts,
  ADD COLUMN delivery_provider VARCHAR(40) NULL AFTER delivery_state,
  ADD COLUMN provider_message_id VARCHAR(191) NULL AFTER delivery_provider,
  ADD COLUMN delivery_detail VARCHAR(200) NULL AFTER provider_message_id,
  ADD COLUMN hash_version TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER code_hash;
