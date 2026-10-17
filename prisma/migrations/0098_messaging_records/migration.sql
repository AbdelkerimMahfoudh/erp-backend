-- ===========================================================================
-- 0098 — Messaging records for Brevo SMTP and the WhatsApp Cloud API (D181; docs/97).
--
-- Why: the brief of 2026-10-17 asks for delivery logs, an internal daily safety limit and per-recipient limits, an
-- asynchronous and idempotent webhook, forward-only message statuses, versioned WhatsApp consent and opt-out. None of
-- it can live in memory: limits must survive a restart, a webhook item must be stored before it is acknowledged, and
-- a consent is a record. Every table holds metadata only — no message body, no code, no one-time link or token, no
-- complete address or number (keyed HMACs under MESSAGING_HASH_KEY, and masked forms).
--
-- email_messages: one row per logical email (a retry of the same message is an attempt on the same row). Feeds the
--   internal daily safety limit and the per-recipient limit. Retention: MESSAGE_LOG_RETENTION_DAYS (default 180).
-- whatsapp_messages: one row per template send; the provider's status moves forward only. Retention: the same.
-- whatsapp_webhook_events: one row per signed webhook item, inserted before the provider is answered and worked by a
--   leased worker; provider retries collapse on dedupe_key; the sender fields are cleared once processed. Retention:
--   WHATSAPP_WEBHOOK_RETENTION_DAYS (default 30, longer than the provider's retry period).
-- whatsapp_contacts: a number's opt-out, its last inbound message (the 24-hour window) and undeliverability.
-- whatsapp_consents: the append-only history of consent grants, opt-outs and withdrawals made in the application.
-- messaging_delivery_proofs.phone_number_id: a proof belongs to the sending number it was made with, so a proof made
--   with Meta's test number never opens the channel for the real one. Existing rows keep NULL and prove nothing for a
--   configured number; no deployment has any today (WhatsApp has never been enabled).
--
-- Purely additive: no existing column changes and no data moves. Rollback: drop the five tables, the index and the
-- column (docs/97 §6); nothing else depends on them.
-- ===========================================================================

-- AlterTable
ALTER TABLE `messaging_delivery_proofs` ADD COLUMN `phone_number_id` VARCHAR(40) NULL;

-- CreateTable
CREATE TABLE `email_messages` (
    `id` BINARY(16) NOT NULL,
    `idempotency_key` VARCHAR(191) NOT NULL,
    `template` VARCHAR(60) NOT NULL,
    `category` VARCHAR(20) NOT NULL,
    `essential` BOOLEAN NOT NULL,
    `language` VARCHAR(5) NOT NULL,
    `sender` VARCHAR(191) NOT NULL,
    `recipient_hash` CHAR(64) NOT NULL,
    `recipient_masked` VARCHAR(80) NOT NULL,
    `provider` VARCHAR(40) NOT NULL,
    `status` VARCHAR(12) NOT NULL,
    `failure_reason` VARCHAR(20) NULL,
    `detail` VARCHAR(200) NULL,
    `provider_message_id` VARCHAR(191) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `accepted_at` DATETIME(6) NULL,

    INDEX `ix_email_messages_created`(`created_at`),
    INDEX `ix_email_messages_recipient`(`recipient_hash`, `created_at`),
    UNIQUE INDEX `ux_email_messages_idempotency`(`idempotency_key`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- CreateTable
CREATE TABLE `whatsapp_messages` (
    `id` BINARY(16) NOT NULL,
    `idempotency_key` VARCHAR(191) NOT NULL,
    `provider_message_id` VARCHAR(191) NULL,
    `phone_number_id` VARCHAR(40) NOT NULL,
    `mode` VARCHAR(8) NOT NULL,
    `template` VARCHAR(60) NOT NULL,
    `template_use` VARCHAR(12) NOT NULL,
    `language` VARCHAR(5) NOT NULL,
    `recipient_hash` CHAR(64) NOT NULL,
    `recipient_masked` VARCHAR(40) NOT NULL,
    `status` VARCHAR(12) NOT NULL,
    `failure_reason` VARCHAR(20) NULL,
    `error_code` INTEGER NULL,
    `detail` VARCHAR(200) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `status_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `delivered_at` DATETIME(6) NULL,
    `read_at` DATETIME(6) NULL,
    `failed_at` DATETIME(6) NULL,

    INDEX `ix_whatsapp_messages_recipient`(`recipient_hash`, `created_at`),
    INDEX `ix_whatsapp_messages_created`(`created_at`),
    UNIQUE INDEX `ux_whatsapp_messages_idempotency`(`idempotency_key`),
    UNIQUE INDEX `ux_whatsapp_messages_provider_id`(`provider_message_id`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- CreateTable
CREATE TABLE `whatsapp_webhook_events` (
    `id` BINARY(16) NOT NULL,
    `dedupe_key` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(10) NOT NULL,
    `provider_message_id` VARCHAR(191) NOT NULL,
    `status` VARCHAR(20) NULL,
    `error_code` INTEGER NULL,
    `sender_hash` CHAR(64) NULL,
    `sender_masked` VARCHAR(40) NULL,
    `opt_out_signal` VARCHAR(8) NULL,
    `occurred_at` DATETIME(6) NULL,
    `state` VARCHAR(12) NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `claim_token` BINARY(16) NULL,
    `claimed_until` DATETIME(6) NULL,
    `next_attempt_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `last_error` VARCHAR(200) NULL,
    `received_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `processed_at` DATETIME(6) NULL,

    INDEX `ix_whatsapp_webhook_events_due`(`state`, `next_attempt_at`),
    INDEX `ix_whatsapp_webhook_events_received`(`received_at`),
    UNIQUE INDEX `ux_whatsapp_webhook_events_dedupe`(`dedupe_key`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- CreateTable
CREATE TABLE `whatsapp_contacts` (
    `id` BINARY(16) NOT NULL,
    `number_hash` CHAR(64) NOT NULL,
    `number_masked` VARCHAR(40) NOT NULL,
    `opt_out_scope` VARCHAR(10) NOT NULL DEFAULT 'none',
    `opt_out_at` DATETIME(6) NULL,
    `opt_out_source` VARCHAR(20) NULL,
    `last_inbound_at` DATETIME(6) NULL,
    `undeliverable_at` DATETIME(6) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    UNIQUE INDEX `ux_whatsapp_contacts_number`(`number_hash`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- CreateTable
CREATE TABLE `whatsapp_consents` (
    `id` BINARY(16) NOT NULL,
    `number_hash` CHAR(64) NOT NULL,
    `number_masked` VARCHAR(40) NOT NULL,
    `event` VARCHAR(20) NOT NULL,
    `version` VARCHAR(40) NULL,
    `purposes` VARCHAR(255) NULL,
    `actor_company_id` BINARY(16) NULL,
    `actor_user_id` BINARY(16) NULL,
    `source` VARCHAR(30) NOT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `ix_whatsapp_consents_number`(`number_hash`, `created_at`),
    INDEX `ix_whatsapp_consents_actor`(`actor_user_id`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- CreateIndex
CREATE INDEX `ix_delivery_proof_number` ON `messaging_delivery_proofs`(`phone_number_id`, `channel`, `delivered_at`);

