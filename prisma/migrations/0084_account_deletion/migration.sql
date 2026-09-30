-- ===========================================================================
-- 0084 — Account deletion with a WhatsApp code (docs/64).
--
-- Why: the App Store requires an in-app way to delete an account, and the
-- product decision (docs/21) is that NO account is deleted through any route
-- unless a single-use deletion code was sent to the account's verified
-- WhatsApp number and entered by the account holder. That rule needs a record
-- of the request itself — who asked, when they re-authenticated, which
-- challenge proved the number, how far the deletion got, and what was kept —
-- so the executor can refuse anything that did not come through the code.
--
-- ## What this adds
--
-- 1. `account_deletion` as an OTP purpose. A code issued to verify a phone or
--    a device can never confirm a deletion, because `resolve()` matches on
--    purpose — the same argument as `0060`/`0061`.
--
--    **Both columns are widened, and `otp_challenges` catches up.** `0060` and
--    `0061` widened `verification_intents` only, so `otp_challenges.purpose`
--    still held the three values of `0025` while the Prisma enum held five.
--    Nothing wrote the two newer purposes to that table, so it never bit; a
--    deletion challenge would have. Both columns now carry the full list.
--
-- 2. `account_deletion_requests`: one row per request. `active_key` is the
--    user id while the request is open and NULL once it is terminal, so the
--    UNIQUE index gives "one open request per person" as a database fact, the
--    same pattern `otp_challenges.active_key` uses. `client_uuid` makes a
--    retried request return the same row. `version` is the optimistic guard
--    for the awaiting → confirmed → processing → completed transitions.
--
-- 3. `companies.closed_at`: when an Owner closed the business. A closed
--    company keeps its name (it is on every retained invoice) and loses its
--    contact details, logo and discoverability; `is_active` goes false so no
--    login in it can sign in.
--
-- Additive: two enum widenings, one new table, one nullable column. No row
-- changes and nothing is dropped.
--
-- Reverse:
--   ALTER TABLE `companies` DROP COLUMN `closed_at`;
--   DROP TABLE `account_deletion_requests`;
--   (the enum widening is safe to leave; narrowing it back needs no row to
--    hold `account_deletion`)
-- ===========================================================================

ALTER TABLE `otp_challenges`
  MODIFY `purpose` ENUM(
    'phone_verification',
    'device_verification',
    'logout_reauth',
    'portal_handoff',
    'registration_continuation',
    'account_deletion'
  ) NOT NULL;

ALTER TABLE `verification_intents`
  MODIFY `purpose` ENUM(
    'phone_verification',
    'device_verification',
    'logout_reauth',
    'portal_handoff',
    'registration_continuation',
    'account_deletion'
  ) NOT NULL;

ALTER TABLE `companies`
  ADD COLUMN `closed_at` DATETIME(6) NULL AFTER `is_active`;

CREATE TABLE IF NOT EXISTS `account_deletion_requests` (
  `id`                    BINARY(16)   NOT NULL,
  `company_id`            BINARY(16)   NOT NULL,
  `user_id`               BINARY(16)   NOT NULL,
  /** personal_login: one person's login · company_closure: the business and every login in it. */
  `kind`                  ENUM('personal_login', 'company_closure') NOT NULL,
  `status`                ENUM('awaiting_code', 'confirmed', 'processing', 'completed', 'cancelled', 'failed')
                          NOT NULL DEFAULT 'awaiting_code',
  /** The live deletion challenge. Replaced on resend; the executor re-reads it. */
  `challenge_id`          BINARY(16)   NULL,
  /** Where the code went, masked. Never the full number. */
  `destination_masked`    VARCHAR(24)  NOT NULL,
  `language`              VARCHAR(5)   NOT NULL DEFAULT 'en',
  /** = user_id while open, NULL once terminal: one open request per person. */
  `active_key`            BINARY(16)   NULL,
  `client_uuid`           BINARY(16)   NULL,
  `request_ip`            VARCHAR(45)  NULL,
  `reauthenticated_at`    DATETIME(6)  NOT NULL,
  `code_sent_at`          DATETIME(6)  NULL,
  `confirmed_at`          DATETIME(6)  NULL,
  `processing_started_at` DATETIME(6)  NULL,
  `completed_at`          DATETIME(6)  NULL,
  `cancelled_at`          DATETIME(6)  NULL,
  `failure_detail`        VARCHAR(200) NULL,
  /** Counts of what was kept and why (sales, purchases, closings, audit rows). */
  `retained_summary`      JSON         NULL,
  `version`               INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`            DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`            DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_account_deletion_active` (`active_key`),
  UNIQUE KEY `ux_account_deletion_client_uuid` (`company_id`, `client_uuid`),
  KEY `ix_account_deletion_company` (`company_id`, `created_at`),
  KEY `ix_account_deletion_user` (`user_id`, `created_at`),
  KEY `ix_account_deletion_challenge` (`challenge_id`),
  CONSTRAINT `fk_account_deletion_company`   FOREIGN KEY (`company_id`)   REFERENCES `companies` (`id`),
  CONSTRAINT `fk_account_deletion_user`      FOREIGN KEY (`user_id`)      REFERENCES `users` (`id`),
  CONSTRAINT `fk_account_deletion_challenge` FOREIGN KEY (`challenge_id`) REFERENCES `otp_challenges` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
