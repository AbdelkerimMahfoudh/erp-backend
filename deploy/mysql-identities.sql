-- ===========================================================================
-- The four database identities (docs/48 §2, docs/15 §4).
--
--   phonestore_migrator  DDL + DML on the application schema and the Prisma
--                        shadow databases. Used ONLY by `prisma migrate` and
--                        the seed, from an operator's shell — never by the API.
--   phonestore_app       DML only. The running API. It cannot alter tables,
--                        cannot create triggers, and the append-only triggers
--                        on audit_logs / subscription_events / platform audit
--                        refuse its UPDATEs and DELETEs by name.
--   phonestore_backup    Read-only, plus what mysqldump needs. The backup job.
--                        It can read everything and change nothing.
--   phonestore_admin     A named person's DBA account for restores and
--                        incident work, granted on the schema, never on the
--                        server. Created per person; this is the template.
--
-- Run as root (or an account with GRANT OPTION). The four passwords live in
-- files (mode 600) and reach MySQL on STANDARD INPUT — never as an argument,
-- which every user on the machine can read in the process list, and never in
-- shell history (docs/22 §2). `printf` is a shell builtin, so its arguments
-- are not a process's arguments either:
--
--   { printf "SET @migrator_pw='%s', @app_pw='%s', @backup_pw='%s', @admin_pw='%s';\n" \
--       "$(cat migrator.pw)" "$(cat app.pw)" "$(cat backup.pw)" "$(cat admin.pw)"
--     cat deploy/mysql-identities.sql; } | mysql --defaults-extra-file=<root option file>
--
-- Make each password with `openssl rand -hex 24`: hexadecimal needs no quoting.
--
-- MySQL takes only a literal after IDENTIFIED BY — `IDENTIFIED BY @var` is a
-- syntax error — so each account statement is built with QUOTE() and run as a
-- prepared statement. Nothing runs unless all four passwords are set and at
-- least 16 characters long: the guard prepares NULL, which fails, and the
-- client stops before any account is touched. No account is ever created with
-- a placeholder password, not even for a moment.
--
-- The schema name is `phonestore`. `prisma\_%` is the shadow-database
-- namespace `prisma migrate dev` creates and drops; production never uses it,
-- so the grant is harmless there and necessary on a developer's machine.
--
-- Binary logging (on by default in MySQL 8): an account without SUPER cannot
-- create a trigger unless the server sets `log_bin_trust_function_creators=1`
-- (ERROR 1419) — the TRIGGER privilege is not enough. Eighteen migrations
-- create triggers (0027 to 0085) and a restore recreates them, so a server with
-- the binary log on needs that setting in its configuration before `prisma
-- migrate deploy` or a restore. Never grant SUPER to the migrator or the admin
-- account instead: it is server-wide.
--
-- Idempotent: an existing account gets the password it is given (ALTER USER),
-- a missing one is created with it, and GRANT is additive. Verify with
-- deploy/verify-mysql-identities.sh, which signs in as each account and proves
-- what it cannot do.
-- ===========================================================================

SET @identities_ready = IF(
  CHAR_LENGTH(IFNULL(@migrator_pw, '')) >= 16 AND CHAR_LENGTH(IFNULL(@app_pw, '')) >= 16 AND
  CHAR_LENGTH(IFNULL(@backup_pw, '')) >= 16 AND CHAR_LENGTH(IFNULL(@admin_pw, '')) >= 16,
  'DO 0', NULL);
PREPARE identities_guard FROM @identities_ready; -- fails here when a password is missing or short
DEALLOCATE PREPARE identities_guard;

SET @identity_sql = CONCAT('CREATE USER IF NOT EXISTS ''phonestore_migrator''@''%'' IDENTIFIED BY ', QUOTE(@migrator_pw));
PREPARE identity_stmt FROM @identity_sql; EXECUTE identity_stmt; DEALLOCATE PREPARE identity_stmt;
SET @identity_sql = CONCAT('ALTER USER ''phonestore_migrator''@''%'' IDENTIFIED BY ', QUOTE(@migrator_pw));
PREPARE identity_stmt FROM @identity_sql; EXECUTE identity_stmt; DEALLOCATE PREPARE identity_stmt;
GRANT ALL PRIVILEGES ON `phonestore`.* TO 'phonestore_migrator'@'%';
GRANT ALL PRIVILEGES ON `prisma\_%`.* TO 'phonestore_migrator'@'%';
-- Already inside ALL PRIVILEGES; named so a grant listing shows it. With the
-- binary log on it is not sufficient on its own (see the header).
GRANT TRIGGER ON `phonestore`.* TO 'phonestore_migrator'@'%';

SET @identity_sql = CONCAT('CREATE USER IF NOT EXISTS ''phonestore_app''@''%'' IDENTIFIED BY ', QUOTE(@app_pw));
PREPARE identity_stmt FROM @identity_sql; EXECUTE identity_stmt; DEALLOCATE PREPARE identity_stmt;
SET @identity_sql = CONCAT('ALTER USER ''phonestore_app''@''%'' IDENTIFIED BY ', QUOTE(@app_pw));
PREPARE identity_stmt FROM @identity_sql; EXECUTE identity_stmt; DEALLOCATE PREPARE identity_stmt;
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'phonestore_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON `phonestore`.* TO 'phonestore_app'@'%';

SET @identity_sql = CONCAT('CREATE USER IF NOT EXISTS ''phonestore_backup''@''localhost'' IDENTIFIED BY ', QUOTE(@backup_pw));
PREPARE identity_stmt FROM @identity_sql; EXECUTE identity_stmt; DEALLOCATE PREPARE identity_stmt;
SET @identity_sql = CONCAT('ALTER USER ''phonestore_backup''@''localhost'' IDENTIFIED BY ', QUOTE(@backup_pw));
PREPARE identity_stmt FROM @identity_sql; EXECUTE identity_stmt; DEALLOCATE PREPARE identity_stmt;
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'phonestore_backup'@'localhost';
-- SELECT to read the rows, SHOW VIEW / TRIGGER / EVENT so the dump carries the
-- schema objects, LOCK TABLES for a consistent non-InnoDB read (InnoDB uses
-- --single-transaction and never locks). Nothing that writes.
GRANT SELECT, SHOW VIEW, TRIGGER, EVENT, LOCK TABLES ON `phonestore`.* TO 'phonestore_backup'@'localhost';
GRANT PROCESS ON *.* TO 'phonestore_backup'@'localhost'; -- mysqldump --single-transaction needs it on 8.0 to read InnoDB metadata without a lock

SET @identity_sql = CONCAT('CREATE USER IF NOT EXISTS ''phonestore_admin''@''localhost'' IDENTIFIED BY ', QUOTE(@admin_pw));
PREPARE identity_stmt FROM @identity_sql; EXECUTE identity_stmt; DEALLOCATE PREPARE identity_stmt;
SET @identity_sql = CONCAT('ALTER USER ''phonestore_admin''@''localhost'' IDENTIFIED BY ', QUOTE(@admin_pw));
PREPARE identity_stmt FROM @identity_sql; EXECUTE identity_stmt; DEALLOCATE PREPARE identity_stmt;
GRANT ALL PRIVILEGES ON `phonestore`.* TO 'phonestore_admin'@'localhost';
GRANT ALL PRIVILEGES ON `phonestore\_%`.* TO 'phonestore_admin'@'localhost'; -- restore-drill copies live beside the schema
GRANT TRIGGER, CREATE ROUTINE, ALTER ROUTINE ON `phonestore`.* TO 'phonestore_admin'@'localhost';
GRANT PROCESS, RELOAD ON *.* TO 'phonestore_admin'@'localhost'; -- FLUSH and SHOW PROCESSLIST during a restore; still no SUPER

FLUSH PRIVILEGES;

-- The passwords leave the session with it; clear them anyway.
SET @identity_sql = NULL, @identities_ready = NULL, @migrator_pw = NULL, @app_pw = NULL, @backup_pw = NULL, @admin_pw = NULL;
