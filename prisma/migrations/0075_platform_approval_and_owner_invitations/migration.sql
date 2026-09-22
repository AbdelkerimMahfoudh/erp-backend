-- 0075 — a refused registration, a corrected period, and an Owner's first key.
--
-- WHY
-- A platform administrator could activate, extend, suspend, reinstate and
-- cancel a subscription, but a registration they REFUSED had nowhere to go:
-- the only ended state was `cancelled`, which reads as a subscription that
-- once ran. An administrator who corrected an end date could only "extend"
-- by whole months, and the record never said it was a correction. And a
-- business created by an administrator for a shop that never filled the form
-- had no way to hand its Owner a first password without somebody typing one
-- into a chat.
--
-- WHAT THIS ADDS
-- subscriptions.status      `rejected` — refused before it ever ran. A
--                           decision, like `suspended`: the app is closed to
--                           it and says which state it is in.
-- subscription_events.kind  `approved` (a pending registration became a
--                           running subscription), `rejected`, and
--                           `period_corrected` (an administrator set the end
--                           date directly; the reason travels on the event).
-- owner_invitations         A single-use, hashed, 72-hour key that lets a
--                           business's Owner set their first password. The
--                           token is never stored; issuing a new one revokes
--                           the old. It is not a session, and accepting it
--                           grants no entitlement — the subscription decides.
--
-- Every existing row keeps its value. Appending ENUM members is an in-place
-- metadata change on MySQL 8; no row is rewritten and nothing is deleted.

ALTER TABLE `subscriptions`
  MODIFY COLUMN `status` ENUM('pending_activation','activated','suspended','cancelled','rejected')
  NOT NULL DEFAULT 'activated';

ALTER TABLE `subscription_events`
  MODIFY COLUMN `kind` ENUM(
    'created',
    'extended',
    'branches_changed',
    'seats_changed',
    'complimentary_granted',
    'complimentary_revoked',
    'backfilled',
    'registered',
    'administrative_grant',
    'suspended',
    'reinstated',
    'cancelled',
    -- 0075: approval, refusal and a corrected end date.
    'approved',
    'rejected',
    'period_corrected'
  ) NOT NULL;

CREATE TABLE `owner_invitations` (
  `id`          BINARY(16)   NOT NULL,
  `company_id`  BINARY(16)   NOT NULL,
  `user_id`     BINARY(16)   NOT NULL,
  -- Only ever the hash. The token exists in one administrator response.
  `token_hash`  VARCHAR(255) NOT NULL,
  `issued_by`   VARCHAR(160) NOT NULL,
  `expires_at`  DATETIME(6)  NOT NULL,
  `accepted_at` DATETIME(6)  NULL,
  `revoked_at`  DATETIME(6)  NULL,
  `created_at`  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_owner_invitations_token` (`token_hash`),
  KEY `ix_owner_invitations_company` (`company_id`, `created_at`),
  CONSTRAINT `fk_owner_invitations_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_owner_invitations_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
