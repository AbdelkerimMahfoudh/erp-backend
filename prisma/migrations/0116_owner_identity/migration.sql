-- ===========================================================================
-- 0116_owner_identity (D227)
--
-- `users` is unique per company only, so nothing stopped an Owner's phone or
-- email from opening another, unrelated business. `owner_identities` holds one
-- row per Owner contact, UNIQUE across the platform: the database decides a race.
-- Staff never appear here, so a person may still work in several businesses.
--
-- Backfill: each contact goes to its oldest Owner in a non-test business. Other
-- businesses already sharing it are untouched and keep working; only NEW
-- businesses are refused. Test businesses neither claim nor are refused.
--
-- `registration_holds`: a public registration for a phone already claimed gets
-- the same answer and the same code as any other; only proving the code reveals
-- that the number has an account. No company exists to attach an intent to.
--
-- Additive. Reverse: DROP TABLE registration_holds, owner_identities.
-- ===========================================================================

CREATE TABLE `owner_identities` (
  `id` BINARY(16) NOT NULL,
  `kind` ENUM('phone', 'email') NOT NULL,
  `value` VARCHAR(160) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `user_id` BINARY(16) NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_owner_identities_kind_value` (`kind`, `value`),
  KEY `ix_owner_identities_user` (`user_id`),
  KEY `ix_owner_identities_company` (`company_id`),
  CONSTRAINT `fk_owner_identities_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_owner_identities_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `registration_holds` (
  `id` BINARY(16) NOT NULL,
  `token_hash` VARCHAR(128) NOT NULL,
  `destination` VARCHAR(160) NOT NULL,
  `challenge_id` BINARY(16) NULL,
  `expires_at` DATETIME(6) NOT NULL,
  `consumed_at` DATETIME(6) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_registration_holds_token` (`token_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO `owner_identities` (`id`, `kind`, `value`, `company_id`, `user_id`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), t.kind, t.value, t.company_id, t.user_id
FROM (
  SELECT 'phone' AS kind, u.phone AS value, u.company_id, u.id AS user_id, c.created_at
  FROM users u
  JOIN companies c ON c.id = u.company_id AND c.is_test = 0 AND c.closed_at IS NULL
  WHERE u.phone IS NOT NULL AND u.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM user_branches ub JOIN roles r ON r.id = ub.role_id WHERE ub.user_id = u.id AND r.`key` = 'owner')
  UNION ALL
  SELECT 'email', LOWER(u.email), u.company_id, u.id, c.created_at
  FROM users u
  JOIN companies c ON c.id = u.company_id AND c.is_test = 0 AND c.closed_at IS NULL
  WHERE u.email IS NOT NULL AND u.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM user_branches ub JOIN roles r ON r.id = ub.role_id WHERE ub.user_id = u.id AND r.`key` = 'owner')
  ORDER BY created_at ASC
) t;
