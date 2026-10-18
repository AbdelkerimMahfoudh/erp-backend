-- ===========================================================================
-- 0099 — Limited grace after a paid period, and the subscription notice outbox (the owner's brief of 2026-10-18;
--        docs/101, D202–D211).
--
-- Why: until now the 72 hours after a paid period's end were DERIVED (`current_period_end` + 72 h) and every paid
-- expiry received them. The brief limits grace to three 72-hour activations per company in any rolling 12 months,
-- consumed the moment one starts, never restored by a renewal, never replayable by editing an expiry, and never given
-- after a free trial. A limit counted from history needs the history: each paid expiry's decision is recorded once,
-- here, and never changed. The brief also asks for portal instructions and lifecycle reminders that go by WhatsApp
-- first, fall back to email only on stated failures, and are never sent twice: a durable identity per logical message
-- (company + period + kind + threshold) with the channel and the fallback recorded.
--
-- grace_episodes: one row per company per paid period end, ever (UNIQUE), immutable (triggers). `granted` starts at
--   the period end and ends exactly 72 hours later; `refused` (three granted activations already started inside the
--   12 calendar months before the period end) starts and ends at it, so the record says "no grace" in the same shape.
--   `uses_before` is how many granted activations counted against it; `window_start` is the period end minus 12
--   months, by MySQL's own calendar arithmetic (the CHECK holds the application to it). Written by the first
--   evaluation after the period end, the minute sweeper, or a lifecycle decision made after it — whichever is first,
--   once, under the subscription lock. A renewal never deletes or shortens one: the allowance it used stays used.
-- subscription_notices: the outbox of the customer-facing subscription messages — the portal instructions after the
--   WhatsApp number is verified, the trial's and the paid period's 72/48/24-hour reminders, the expiry, and the grace
--   reminders and end. One row per logical message (UNIQUE identity); a retry, a restart or a second worker reuses it.
--   It records which channel carried it (WhatsApp first; email only as the recorded fallback), why email was used,
--   each channel's outcome, a masked destination and a keyed hash of it (MESSAGING_HASH_KEY) — never a number, an
--   address, a body, a code or a token. A lease (claim token, claimed_until) keeps two workers off one row.
-- subscriptions gains an index on current_period_end for the sweepers that look for periods ending or ended.
-- subscription_events.kind gains `grace_started` and `grace_unavailable`, with the Prisma enum (0057: an unlisted kind
--   would be stored as '' under an empty sql_mode).
--
-- Additive: no existing row changes, no backfill. A period that ended before this migration has no recorded decision;
-- the first evaluation after the deployment records it as the rules say (docs/101 §3).
-- Reverse (only while the API that writes these tables is stopped; delete the subscription_events rows of the two new
-- kinds first, or MySQL blanks them):
--   DROP TABLE `subscription_notices`;
--   DROP TABLE `grace_episodes`;
--   DROP INDEX `ix_subscriptions_period_end` ON `subscriptions`;
--   ALTER TABLE `subscription_events` MODIFY `kind` ENUM('created','extended','branches_changed','seats_changed','complimentary_granted','complimentary_revoked','backfilled','registered','administrative_grant','suspended','reinstated','cancelled','approved','rejected','period_corrected','seat_requested','seat_paid','staff_activated','seat_closed','store_requested','activity_requested','activity_changed','activity_scheduled','renewed','trial_eligible','trial_claimed','trial_expired') NOT NULL;
--   DELETE FROM `_prisma_migrations` WHERE `migration_name` = '0099_grace_and_notices';
-- ===========================================================================

-- 1. Each paid expiry's grace decision, once, forever ---------------------------------
CREATE TABLE IF NOT EXISTS `grace_episodes` (
  `id`              BINARY(16)       NOT NULL,
  `company_id`      BINARY(16)       NOT NULL,
  `subscription_id` BINARY(16)       NOT NULL,
  `period_end`      DATETIME(6)      NOT NULL,
  `decision`        ENUM('granted','refused') NOT NULL,
  `started_at`      DATETIME(6)      NOT NULL,
  `ends_at`         DATETIME(6)      NOT NULL,
  `uses_before`     TINYINT UNSIGNED NOT NULL,
  `window_start`    DATETIME(6)      NOT NULL,
  `recorded_at`     DATETIME(6)      NOT NULL,
  `recorded_by`     ENUM('evaluation','sweeper','lifecycle') NOT NULL,
  `created_at`      DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_grace_episode_company_period` (`company_id`, `period_end`),
  KEY `ix_grace_episodes_window` (`company_id`, `decision`, `started_at`),
  CONSTRAINT `ck_grace_episode_start` CHECK (`started_at` = `period_end`),
  CONSTRAINT `ck_grace_episode_span` CHECK (
    (`decision` = 'granted' AND `ends_at` = `started_at` + INTERVAL 72 HOUR)
    OR (`decision` = 'refused' AND `ends_at` = `started_at`)),
  CONSTRAINT `ck_grace_episode_allowance` CHECK (
    (`decision` = 'granted' AND `uses_before` < 3) OR (`decision` = 'refused' AND `uses_before` >= 3)),
  CONSTRAINT `ck_grace_episode_window` CHECK (`window_start` = `period_end` - INTERVAL 12 MONTH),
  CONSTRAINT `ck_grace_episode_recorded` CHECK (`recorded_at` >= `period_end`),
  CONSTRAINT `fk_grace_episodes_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_grace_episodes_subscription` FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 2. The subscription notice outbox -----------------------------------------------------
--    `threshold` and `period_key` are lower-case ASCII the server builds (h72, end, resend:<uuid>; paid:<epoch ms>,
--    trial:<uuid>): no two identities differ by case alone, so the table's collation cannot merge them.
CREATE TABLE IF NOT EXISTS `subscription_notices` (
  `id`                   BINARY(16)   NOT NULL,
  `company_id`           BINARY(16)   NOT NULL,
  `subscription_id`      BINARY(16)   NOT NULL,
  `kind`                 ENUM('portal_instructions','trial_reminder','trial_expired','paid_reminder','paid_expired','grace_reminder','grace_ended') NOT NULL,
  `threshold`            VARCHAR(48)  NOT NULL,
  `period_key`           VARCHAR(80)  NOT NULL,
  `variant`              VARCHAR(20)  NULL,
  `due_at`               DATETIME(6)  NOT NULL,
  `state`                ENUM('pending','sending','accepted','delivered','failed','cancelled','superseded') NOT NULL DEFAULT 'pending',
  `channel`              ENUM('whatsapp','email') NULL,
  `whatsapp_outcome`     VARCHAR(20)  NULL,
  `email_outcome`        VARCHAR(20)  NULL,
  `fallback_reason`      VARCHAR(30)  NULL,
  `failure_reason`       VARCHAR(30)  NULL,
  `destination_masked`   VARCHAR(80)  NULL,
  `destination_hash`     CHAR(64)     NULL,
  `language`             VARCHAR(5)   NOT NULL,
  `requested_by_user_id` BINARY(16)   NULL,
  `attempts`             INT UNSIGNED NOT NULL DEFAULT 0,
  `next_attempt_at`      DATETIME(6)  NOT NULL,
  `claim_token`          BINARY(16)   NULL,
  `claimed_until`        DATETIME(6)  NULL,
  `accepted_at`          DATETIME(6)  NULL,
  `completed_at`         DATETIME(6)  NULL,
  `cancel_reason`        VARCHAR(40)  NULL,
  `created_at`           DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`           DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_subscription_notice_identity` (`company_id`, `period_key`, `kind`, `threshold`),
  KEY `ix_subscription_notices_queue` (`state`, `next_attempt_at`),
  KEY `ix_subscription_notices_company` (`company_id`, `created_at`),
  CONSTRAINT `ck_subscription_notice_channel` CHECK (`state` NOT IN ('accepted','delivered') OR `channel` IS NOT NULL),
  CONSTRAINT `ck_subscription_notice_lease` CHECK ((`claim_token` IS NULL) = (`claimed_until` IS NULL)),
  CONSTRAINT `fk_subscription_notices_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_subscription_notices_subscription` FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_subscription_notices_requested_by` FOREIGN KEY (`requested_by_user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 3. The sweepers look for periods ending or ended --------------------------------------
CREATE INDEX `ix_subscriptions_period_end` ON `subscriptions` (`current_period_end`);

-- 4. A grace decision is final ------------------------------------------------------------
DROP TRIGGER IF EXISTS `trg_grace_episode_no_update`;
CREATE TRIGGER `trg_grace_episode_no_update`
BEFORE UPDATE ON `grace_episodes`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'grace_episodes is immutable: a grace decision is never edited';
  END IF;
END;

DROP TRIGGER IF EXISTS `trg_grace_episode_no_delete`;
CREATE TRIGGER `trg_grace_episode_no_delete`
BEFORE DELETE ON `grace_episodes`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'grace_episodes is immutable: a used grace period is never given back';
  END IF;
END;

-- 5. The timeline learns grace ------------------------------------------------------------
ALTER TABLE `subscription_events`
  MODIFY `kind` ENUM('created','extended','branches_changed','seats_changed','complimentary_granted','complimentary_revoked','backfilled','registered','administrative_grant','suspended','reinstated','cancelled','approved','rejected','period_corrected','seat_requested','seat_paid','staff_activated','seat_closed','store_requested','activity_requested','activity_changed','activity_scheduled','renewed','trial_eligible','trial_claimed','trial_expired','grace_started','grace_unavailable') NOT NULL;
