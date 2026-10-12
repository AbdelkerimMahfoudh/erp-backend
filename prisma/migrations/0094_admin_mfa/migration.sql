-- 0094 — mandatory TOTP MFA for platform administrators (correction phase, 2026-10-12; docs/48).
--
-- platform_admins: the sealed TOTP secret (AES-256-GCM under PLATFORM_MFA_KEY), when it was confirmed, the last
--   step used (replay), the pending secret during enrolment, the one-time enrolment token's digest and expiry
--   (issued only by the server CLI), and the failure counter and lock.
-- platform_admin_sessions: when the session's second factor was verified (a session without it reaches the MFA
--   routes only), and the last step-up (password + code), checked server-side with a five-minute expiry.
-- platform_admin_recovery_codes: ten single-use codes per set, keyed digests only; a new set revokes the old.
--
-- Additive: existing administrators have no MFA, so they reach nothing until enrolled with a CLI token.
-- Reverse:
--   DROP TABLE platform_admin_recovery_codes;
--   ALTER TABLE platform_admin_sessions DROP COLUMN step_up_at, DROP COLUMN mfa_verified_at;
--   ALTER TABLE platform_admins DROP COLUMN mfa_locked_until, DROP COLUMN mfa_failed_count,
--     DROP COLUMN mfa_enrolment_expires_at, DROP COLUMN mfa_enrolment_token_hash, DROP COLUMN mfa_pending_secret_enc,
--     DROP COLUMN mfa_last_step, DROP COLUMN mfa_enabled_at, DROP COLUMN mfa_secret_enc;

ALTER TABLE platform_admins
  ADD COLUMN mfa_secret_enc VARCHAR(255) NULL AFTER password_hash,
  ADD COLUMN mfa_enabled_at DATETIME(6) NULL AFTER mfa_secret_enc,
  ADD COLUMN mfa_last_step BIGINT NULL AFTER mfa_enabled_at,
  ADD COLUMN mfa_pending_secret_enc VARCHAR(255) NULL AFTER mfa_last_step,
  ADD COLUMN mfa_enrolment_token_hash CHAR(64) NULL AFTER mfa_pending_secret_enc,
  ADD COLUMN mfa_enrolment_expires_at DATETIME(6) NULL AFTER mfa_enrolment_token_hash,
  ADD COLUMN mfa_failed_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER mfa_enrolment_expires_at,
  ADD COLUMN mfa_locked_until DATETIME(6) NULL AFTER mfa_failed_count;

ALTER TABLE platform_admin_sessions
  ADD COLUMN mfa_verified_at DATETIME(6) NULL AFTER revoked_at,
  ADD COLUMN step_up_at DATETIME(6) NULL AFTER mfa_verified_at;

CREATE TABLE platform_admin_recovery_codes (
  id BINARY(16) NOT NULL,
  admin_id BINARY(16) NOT NULL,
  code_hash CHAR(64) NOT NULL,
  used_at DATETIME(6) NULL,
  revoked_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY ux_admin_recovery_code (admin_id, code_hash),
  CONSTRAINT fk_admin_recovery_codes_admin FOREIGN KEY (admin_id) REFERENCES platform_admins (id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
