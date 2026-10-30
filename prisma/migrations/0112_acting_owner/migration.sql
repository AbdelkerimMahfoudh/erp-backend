-- ===========================================================================
-- 0112 — the temporary Acting Owner (D225, the owner's TestFlight feedback of
-- 2026-10-29).
--
-- An Owner appoints one active staff member to run the business while they
-- are away: from now or from a set time, until a set time or until revoked.
-- The person keeps their own role. The authority is added on top, on the
-- server, for every request while `starts_at <= now < ends_at` (or no end)
-- and `revoked_at IS NULL`. So it begins and ends on time with both phones
-- off, and stops on the next request after a revocation. No job is needed.
--
-- One active Acting Owner per business. A new appointment takes the business
-- row's lock and is refused if its window overlaps one still running or still
-- to come, so two parallel requests cannot both appoint.
--
-- The rows are never deleted. A revocation is a date and a person on the
-- same row. Every appointment and revocation is also in `audit_logs`, whose
-- triggers keep it unchangeable.
--
-- Additive: a new table, nothing else changes. Reverse: DROP TABLE (the
-- appointments then end; take a dump first, per docs/22).
-- ===========================================================================

CREATE TABLE `acting_owner_delegations` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `delegate_user_id` BINARY(16) NOT NULL,
  `granted_by_user_id` BINARY(16) NOT NULL,
  `starts_at` DATETIME(6) NOT NULL,
  `ends_at` DATETIME(6) NULL,
  `revoked_at` DATETIME(6) NULL,
  `revoked_by_user_id` BINARY(16) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `acting_owner_company_window` (`company_id`, `revoked_at`, `starts_at`),
  KEY `acting_owner_delegate` (`delegate_user_id`, `revoked_at`),
  CONSTRAINT `acting_owner_company_fk` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `acting_owner_delegate_fk` FOREIGN KEY (`delegate_user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `acting_owner_granted_by_fk` FOREIGN KEY (`granted_by_user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `acting_owner_revoked_by_fk` FOREIGN KEY (`revoked_by_user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `acting_owner_ends_after_start` CHECK (`ends_at` IS NULL OR `ends_at` > `starts_at`),
  CONSTRAINT `acting_owner_revocation_whole` CHECK ((`revoked_at` IS NULL) = (`revoked_by_user_id` IS NULL))
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- An appointment is history: never deleted, and the only change ever made to it is its revocation, once. Enforced
-- for every account, the application's included, so no code path can rewrite who held the Owner's authority, when.
DROP TRIGGER IF EXISTS `trg_acting_owner_no_delete`;
CREATE TRIGGER `trg_acting_owner_no_delete`
BEFORE DELETE ON `acting_owner_delegations`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'An Acting Owner appointment is never deleted: revoke it.';
END;

DROP TRIGGER IF EXISTS `trg_acting_owner_revoke_only`;
CREATE TRIGGER `trg_acting_owner_revoke_only`
BEFORE UPDATE ON `acting_owner_delegations`
FOR EACH ROW
BEGIN
  IF NOT (NEW.`id` <=> OLD.`id`) OR NOT (NEW.`company_id` <=> OLD.`company_id`)
     OR NOT (NEW.`delegate_user_id` <=> OLD.`delegate_user_id`) OR NOT (NEW.`granted_by_user_id` <=> OLD.`granted_by_user_id`)
     OR NOT (NEW.`starts_at` <=> OLD.`starts_at`) OR NOT (NEW.`ends_at` <=> OLD.`ends_at`)
     OR NOT (NEW.`created_at` <=> OLD.`created_at`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'An Acting Owner appointment is not changed: revoke it and appoint again.';
  END IF;
  IF OLD.`revoked_at` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This Acting Owner appointment is already revoked.';
  END IF;
END;
