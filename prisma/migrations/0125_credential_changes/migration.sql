-- D227: changing a password, WhatsApp number or email in stages, and a purpose for its codes. Additive.
-- Reverse, only before any change exists: DROP the table and remove the enum value.
ALTER TABLE `otp_challenges` MODIFY `purpose` ENUM('phone_verification','device_verification','logout_reauth','portal_handoff','registration_continuation','account_deletion','acting_owner_step_up','personal_login','credential_change') NOT NULL;
ALTER TABLE `verification_intents` MODIFY `purpose` ENUM('phone_verification','device_verification','logout_reauth','portal_handoff','registration_continuation','account_deletion','acting_owner_step_up','credential_change') NOT NULL;
CREATE TABLE `credential_changes` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `user_id` BINARY(16) NOT NULL,
  `kind` VARCHAR(16) NOT NULL,
  `stage` VARCHAR(16) NOT NULL,
  `new_contact` VARCHAR(160) NULL,
  `old_code_id` BINARY(16) NOT NULL,
  `old_code_channel` VARCHAR(8) NOT NULL,
  `new_code_id` BINARY(16) NULL,
  `new_code_channel` VARCHAR(8) NULL,
  `expires_at` DATETIME(6) NOT NULL,
  `completed_at` DATETIME(6) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `ix_credential_changes_user` (`user_id`, `stage`),
  CONSTRAINT `fk_credential_changes_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_credential_changes_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
