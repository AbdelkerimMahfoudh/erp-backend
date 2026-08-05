-- 0020 — Contactable users (F1 Stage 1, docs/23 §4 Stage 1).
--
-- ADDITIVE ONLY. Four nullable columns on `users` and one unique index. Nothing
-- existing is altered or dropped, so every current user stays valid and keeps
-- authenticating exactly as before — `login` and `password_hash` are untouched.
--
-- Why nullable, and why no onboarding-status column: the six existing users have
-- no phone or email, and must NOT be pushed into an "incomplete onboarding"
-- state by this migration. A user with `phone IS NULL` is simply not yet
-- contactable; the app derives that "pending contact" state for display. There
-- is no lifecycle column here to get wrong.
--
-- Why the phone index is UNIQUE at the database level: phone becomes the
-- WhatsApp OTP and recovery channel, so two accounts must never share one
-- number. Enforcing it in application code alone would let two devices race onto
-- the same phone. MySQL treats every row whose indexed value is NULL as distinct
-- for uniqueness, so all six current (NULL-phone) users coexist under this index
-- and future NULLs never collide — only a real, repeated number is rejected.
--
-- Email is intentionally NOT unique in Stage 1: docs/23 §4 enforces uniqueness
-- only on phone; email is optional recovery and its uniqueness is deferred.
--
-- `*_verified_at` stay NULL until a real verification event sets them (Stage 4,
-- OTP). Nothing in Stage 1 may claim a contact is verified. The service clears
-- the matching timestamp whenever a contact value changes.
--
-- Rerun safety: this migration is applied once and recorded in
-- `_prisma_migrations`; `prisma migrate deploy` never re-runs an applied
-- migration. It contains no data writes, so it cannot duplicate data.

-- AlterTable
ALTER TABLE `users` ADD COLUMN `email` VARCHAR(160) NULL,
    ADD COLUMN `email_verified_at` DATETIME(6) NULL,
    ADD COLUMN `phone` VARCHAR(24) NULL,
    ADD COLUMN `phone_verified_at` DATETIME(6) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `users_company_id_phone_key` ON `users`(`company_id`, `phone`);
