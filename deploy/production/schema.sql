-- ===========================================================================
-- The production schema (docs/100 §4). Run as root on the production database server, before
-- deploy/mysql-identities.sql, whose grants already name `phonestore` (deploy/production/setup-database.sh does both).
-- Its character set and collation are the server's own (utf8mb4, utf8mb4_0900_ai_ci), stated so a different server
-- default can never change them.
-- ===========================================================================

CREATE DATABASE IF NOT EXISTS `phonestore` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
