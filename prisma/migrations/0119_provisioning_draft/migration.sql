-- D227: an administrator's account is a marked draft until its access basis is applied. Additive: every existing row stays NULL, an ordinary account.
ALTER TABLE `companies`
  ADD COLUMN `provisioning_state` VARCHAR(16) NULL,
  ADD COLUMN `provisioning_basis` JSON NULL;
