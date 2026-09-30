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
-- Run as root (or an account with GRANT OPTION), with the four passwords
-- supplied as session variables so they never sit in this file or in shell
-- history:
--
--   mysql -u root -p \
--     -e "SET @migrator_pw='…', @app_pw='…', @backup_pw='…', @admin_pw='…'; SOURCE deploy/mysql-identities.sql;"
--
-- The schema name is `phonestore`. `prisma\_%` is the shadow-database
-- namespace `prisma migrate dev` creates and drops; production never uses it,
-- so the grant is harmless there and necessary on a developer's machine.
--
-- Idempotent: CREATE USER IF NOT EXISTS + ALTER USER, and GRANT is additive.
-- Verify with deploy/verify-mysql-identities.sh, which signs in as each
-- account and proves what it cannot do.
-- ===========================================================================

CREATE USER IF NOT EXISTS 'phonestore_migrator'@'%' IDENTIFIED BY 'placeholder';
ALTER USER 'phonestore_migrator'@'%' IDENTIFIED BY @migrator_pw;
GRANT ALL PRIVILEGES ON `phonestore`.* TO 'phonestore_migrator'@'%';
GRANT ALL PRIVILEGES ON `prisma\_%`.* TO 'phonestore_migrator'@'%';
-- Triggers with a DEFINER need this only where binary logging is on and the
-- server does not trust function creators; grant TRIGGER explicitly rather
-- than SUPER, which is server-wide.
GRANT TRIGGER ON `phonestore`.* TO 'phonestore_migrator'@'%';

CREATE USER IF NOT EXISTS 'phonestore_app'@'%' IDENTIFIED BY 'placeholder';
ALTER USER 'phonestore_app'@'%' IDENTIFIED BY @app_pw;
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'phonestore_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON `phonestore`.* TO 'phonestore_app'@'%';

CREATE USER IF NOT EXISTS 'phonestore_backup'@'localhost' IDENTIFIED BY 'placeholder';
ALTER USER 'phonestore_backup'@'localhost' IDENTIFIED BY @backup_pw;
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'phonestore_backup'@'localhost';
-- SELECT to read the rows, SHOW VIEW / TRIGGER / EVENT so the dump carries the
-- schema objects, LOCK TABLES for a consistent non-InnoDB read (InnoDB uses
-- --single-transaction and never locks). Nothing that writes.
GRANT SELECT, SHOW VIEW, TRIGGER, EVENT, LOCK TABLES ON `phonestore`.* TO 'phonestore_backup'@'localhost';
GRANT PROCESS ON *.* TO 'phonestore_backup'@'localhost'; -- mysqldump --single-transaction needs it on 8.0 to read InnoDB metadata without a lock

CREATE USER IF NOT EXISTS 'phonestore_admin'@'localhost' IDENTIFIED BY 'placeholder';
ALTER USER 'phonestore_admin'@'localhost' IDENTIFIED BY @admin_pw;
GRANT ALL PRIVILEGES ON `phonestore`.* TO 'phonestore_admin'@'localhost';
GRANT ALL PRIVILEGES ON `phonestore\_%`.* TO 'phonestore_admin'@'localhost'; -- restore-drill copies live beside the schema
GRANT TRIGGER, CREATE ROUTINE, ALTER ROUTINE ON `phonestore`.* TO 'phonestore_admin'@'localhost';
GRANT PROCESS, RELOAD ON *.* TO 'phonestore_admin'@'localhost'; -- FLUSH and SHOW PROCESSLIST during a restore; still no SUPER

FLUSH PRIVILEGES;
