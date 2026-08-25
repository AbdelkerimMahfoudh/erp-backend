-- Platform control: a lifecycle for subscriptions, and the tables that let us
-- administer the platform without being a shop.
--
-- Entirely additive except for one new column on `subscriptions`, whose default
-- reproduces exactly what every existing row already did. No existing row
-- changes behaviour.

-- ---------------------------------------------------------------------------
-- 1. Where a subscription sits in its lifecycle.
--
-- `activated` means "the dates decide", which is how every subscription behaved
-- before this column existed. Existing rows therefore take it and nothing about
-- them changes. `pending_activation` exists because telling a shop that
-- registered five minutes ago that its subscription EXPIRED is untrue.
-- ---------------------------------------------------------------------------
ALTER TABLE `subscriptions`
  ADD COLUMN `status` ENUM('pending_activation','activated','suspended','cancelled')
  NOT NULL DEFAULT 'activated' AFTER `company_id`;

-- ---------------------------------------------------------------------------
-- 2. Platform administrators.
--
-- Their own table, not a RoleKey on `users`. A tenant role lives inside a
-- company, so "administrator" as a company role would mean a shop could mint
-- one. These belong to no company, and there is no path from a store role here.
-- ---------------------------------------------------------------------------
CREATE TABLE `platform_admins` (
  `id`            BINARY(16)   NOT NULL,
  `email`         VARCHAR(160) NOT NULL,
  `name`          VARCHAR(160) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `is_active`     TINYINT(1)   NOT NULL DEFAULT 1,
  `last_login_at` DATETIME(6)  NULL,
  `created_at`    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `deleted_at`    DATETIME(6)  NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_platform_admins_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `platform_admin_sessions` (
  `id`                 BINARY(16)   NOT NULL,
  `admin_id`           BINARY(16)   NOT NULL,
  `refresh_token_hash` VARCHAR(255) NOT NULL,
  `ip`                 VARCHAR(45)  NULL,
  `user_agent`         VARCHAR(255) NULL,
  `expires_at`         DATETIME(6)  NOT NULL,
  `revoked_at`         DATETIME(6)  NULL,
  `created_at`         DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `ix_platform_sessions_admin` (`admin_id`),
  KEY `ix_platform_sessions_expiry` (`expires_at`),
  CONSTRAINT `fk_platform_sessions_admin` FOREIGN KEY (`admin_id`)
    REFERENCES `platform_admins` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- 3. The platform audit log. Append-only, enforced below.
-- ---------------------------------------------------------------------------
CREATE TABLE `platform_audit_events` (
  `id`           BINARY(16)   NOT NULL,
  `admin_id`     BINARY(16)   NULL,
  `actor`        VARCHAR(160) NOT NULL,
  `action`       VARCHAR(60)  NOT NULL,
  `target_type`  VARCHAR(40)  NOT NULL,
  `target_id`    BINARY(16)   NULL,
  `target_label` VARCHAR(200) NULL,
  `reason`       VARCHAR(500) NULL,
  `before_state` JSON         NULL,
  `after_state`  JSON         NULL,
  `ip`           VARCHAR(45)  NULL,
  `created_at`   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `ix_platform_audit_created` (`created_at`),
  KEY `ix_platform_audit_target` (`target_type`, `target_id`),
  KEY `ix_platform_audit_action` (`action`),
  CONSTRAINT `fk_platform_audit_admin` FOREIGN KEY (`admin_id`)
    REFERENCES `platform_admins` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- 4. Subscription payments — money a shop paid US.
--
-- Not `payments`: that table is a till payment against a sale and carries a
-- `sale_id`. Append-only; a correction is a compensating row, never an edit.
--
-- Nothing here is provider-verified. `confirmed_by` means "a named
-- administrator says they saw this money", never "a provider confirmed it".
-- ---------------------------------------------------------------------------
CREATE TABLE `subscription_payments` (
  `id`              BINARY(16)     NOT NULL,
  `company_id`      BINARY(16)     NOT NULL,
  `subscription_id` BINARY(16)     NOT NULL,
  `amount`          DECIMAL(14,2)  NOT NULL,
  `currency`        CHAR(3)        NOT NULL DEFAULT 'MRU',
  `paid_at`         DATETIME(6)    NOT NULL,
  `channel`         ENUM('manual','bank_transfer','mobile_money') NOT NULL DEFAULT 'manual',
  `reference`       VARCHAR(120)   NULL,
  `note`            VARCHAR(500)   NULL,
  `recorded_by`     VARCHAR(160)   NOT NULL,
  `confirmed_by`    VARCHAR(160)   NULL,
  `confirmed_at`    DATETIME(6)    NULL,
  `reverses_id`     BINARY(16)     NULL,
  `created_at`      DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `ix_subpayments_company` (`company_id`, `paid_at`),
  CONSTRAINT `fk_subpayments_company` FOREIGN KEY (`company_id`)
    REFERENCES `companies` (`id`),
  CONSTRAINT `fk_subpayments_subscription` FOREIGN KEY (`subscription_id`)
    REFERENCES `subscriptions` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- 5. Registration idempotency.
--
-- Without the unique key, a flaky connection during sign-up produces two
-- companies, two Owners and two branches, and the shopkeeper cannot tell which
-- one is theirs.
-- ---------------------------------------------------------------------------
CREATE TABLE `registration_attempts` (
  `id`              BINARY(16)   NOT NULL,
  `idempotency_key` VARCHAR(80)  NOT NULL,
  `company_id`      BINARY(16)   NULL,
  `business_name`   VARCHAR(160) NOT NULL,
  `owner_name`      VARCHAR(160) NOT NULL,
  `city`            VARCHAR(120) NULL,
  `email`           VARCHAR(160) NULL,
  `phone`           VARCHAR(24)  NULL,
  `language`        VARCHAR(5)   NOT NULL DEFAULT 'en',
  `created_at`      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_registration_idem` (`idempotency_key`),
  KEY `ix_registration_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- 6. Contact verification.
--
-- Proving somebody holds a contact, once, at registration. NOT two-step login
-- verification, which does not exist. Only the hash is stored — a leaked
-- database must not hand somebody a working code.
-- ---------------------------------------------------------------------------
CREATE TABLE `contact_verifications` (
  `id`          BINARY(16)   NOT NULL,
  `channel`     ENUM('email','phone') NOT NULL,
  `destination` VARCHAR(160) NOT NULL,
  `code_hash`   VARCHAR(255) NOT NULL,
  `expires_at`  DATETIME(6)  NOT NULL,
  `attempts`    INT UNSIGNED NOT NULL DEFAULT 0,
  `consumed_at` DATETIME(6)  NULL,
  `created_at`  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `ix_contact_verif_dest` (`destination`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- 7. The platform audit log is append-only.
--
-- Same protection `subscription_events` already carries, and for the same
-- reason: "who suspended this shop, and why" is exactly the question somebody
-- asks months later, and an answer that can be quietly edited is worth nothing.
--
-- The application account is blocked; the migrator is not, so a schema change
-- remains possible. `USER()` is the connecting account, which the app cannot
-- change.
-- ---------------------------------------------------------------------------
CREATE TRIGGER `trg_platform_audit_no_update`
BEFORE UPDATE ON `platform_audit_events`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_audit_events is append-only';
  END IF;
END;

CREATE TRIGGER `trg_platform_audit_no_delete`
BEFORE DELETE ON `platform_audit_events`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_audit_events is append-only';
  END IF;
END;

-- Subscription payments are history too. A correction is a compensating row.
CREATE TRIGGER `trg_subpayments_no_delete`
BEFORE DELETE ON `subscription_payments`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'subscription_payments is append-only';
  END IF;
END;
