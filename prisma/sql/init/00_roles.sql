-- ===========================================================================
-- 00_roles.sql — MySQL user bootstrap (run ONCE, as root/DBA, BEFORE migrations)
-- ---------------------------------------------------------------------------
-- Provider-generic MySQL 8.0+. Locally this can be the WAMP MySQL 8.4 instance,
-- but nothing here is WAMP-specific.
--
-- Two separated users (least privilege — MySQL has no RLS, so tenant isolation
-- is enforced in the application layer; these users are defense-in-depth):
--   * phonestore_migrator — owns DDL, runs Prisma migrations & seed. Full rights
--                           on the phonestore schema (+ CREATE/DROP for the
--                           Prisma shadow database used by `migrate dev`).
--   * phonestore_app       — application runtime user. DML only; and (via
--                           10_grants_post.sql) NO UPDATE/DELETE on audit_logs.
--
-- Replace the dev passwords below with strong secrets in any real environment.
-- ===========================================================================

CREATE DATABASE IF NOT EXISTS `phonestore`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- Migrator: full rights on phonestore.*; plus rights on shadow DBs (prisma_*)
-- so `prisma migrate dev` can create/drop its shadow database.
CREATE USER IF NOT EXISTS 'phonestore_migrator'@'localhost' IDENTIFIED BY 'migrator_dev_pw';
CREATE USER IF NOT EXISTS 'phonestore_migrator'@'%'         IDENTIFIED BY 'migrator_dev_pw';
GRANT ALL PRIVILEGES ON `phonestore`.* TO 'phonestore_migrator'@'localhost';
GRANT ALL PRIVILEGES ON `phonestore`.* TO 'phonestore_migrator'@'%';
GRANT ALL PRIVILEGES ON `prisma\_%`.*  TO 'phonestore_migrator'@'localhost';
GRANT ALL PRIVILEGES ON `prisma\_%`.*  TO 'phonestore_migrator'@'%';

-- Application user: schema-level DML (covers current AND future tables).
-- The audit-log append-only restriction is applied post-migration.
CREATE USER IF NOT EXISTS 'phonestore_app'@'localhost' IDENTIFIED BY 'app_dev_pw';
CREATE USER IF NOT EXISTS 'phonestore_app'@'%'         IDENTIFIED BY 'app_dev_pw';
GRANT SELECT, INSERT, UPDATE, DELETE ON `phonestore`.* TO 'phonestore_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `phonestore`.* TO 'phonestore_app'@'%';

FLUSH PRIVILEGES;
