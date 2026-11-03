-- Post-Build-4 (owner, 2026-11-03): the account-ready message's link. Opaque, single-use, short-lived: 256 random bits,
-- of which only the SHA-256 is stored; bound to one business and its Owner; spent exactly once by a conditional write,
-- and only for a portal session (the trial is claimed on the page, by the Owner, as before). A new link revokes the
-- open one. Nothing about the customer is in the link itself.
-- Additive. Reverse: DROP TABLE portal_claim_links.
CREATE TABLE `portal_claim_links` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `user_id` BINARY(16) NOT NULL,
  `notice_id` BINARY(16) NULL,
  `token_hash` CHAR(64) NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `expires_at` DATETIME(6) NOT NULL,
  `used_at` DATETIME(6) NULL,
  `revoked_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_portal_claim_links_token` (`token_hash`),
  KEY `ix_portal_claim_links_company` (`company_id`, `used_at`, `revoked_at`),
  CONSTRAINT `fk_portal_claim_links_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_portal_claim_links_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `ck_portal_claim_links_once` CHECK (`used_at` IS NULL OR `revoked_at` IS NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
