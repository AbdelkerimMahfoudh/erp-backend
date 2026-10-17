-- ===========================================================================
-- The staging schema, for the four identities of deploy/mysql-identities.sql.
--
-- Staging runs on its own MySQL server with its own passwords. Its schema is called `phonestore_staging` so every
-- staging tool can tell it is not production (scripts/staging-*.ts refuse a database whose name does not say so).
-- The identity script grants on `phonestore`; this grants the same rights, identity by identity, on the staging
-- schema. The audit triggers check the account NAME (`phonestore_app`), so the API must use that account here too.
--
-- Run as root, right after deploy/mysql-identities.sql, on the STAGING server only (deploy/staging/setup-database.sh
-- does both, in that order, every time — the identity script's REVOKE resets the app and backup accounts).
-- ===========================================================================

CREATE DATABASE IF NOT EXISTS `phonestore_staging` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

GRANT ALL PRIVILEGES ON `phonestore_staging`.* TO 'phonestore_migrator'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON `phonestore_staging`.* TO 'phonestore_app'@'%';
GRANT SELECT, SHOW VIEW, TRIGGER, EVENT, LOCK TABLES ON `phonestore_staging`.* TO 'phonestore_backup'@'localhost';
-- phonestore_admin already holds `phonestore\_%`, which covers phonestore_staging and its restore-drill copies.

FLUSH PRIVILEGES;
