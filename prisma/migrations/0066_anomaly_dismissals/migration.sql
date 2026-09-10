-- 0066 — Dismissing an anomaly for seven days (A3).
--
-- Additive only: one new table, its indexes and its foreign keys. No
-- existing column is altered and no data is migrated, so a code rollback
-- leaves this table in place and unused, which is harmless.
--
-- The anomalies themselves are NOT stored. Every one of the six rules is
-- computed on read from rollups and ledgers that already exist, because a
-- stored anomaly is a second copy of a figure the shop already has — and
-- a stale one within the hour. What is stored is the only thing that
-- cannot be recomputed: that somebody looked at it and said "I know".
--
-- Hand-written rather than generated, for the reason recorded in 0065:
-- `prisma migrate diff` against this history produces 1172 lines dropping
-- foreign keys on unrelated tables, because the history carries hand-tuned
-- SQL the datamodel does not describe. Only the additive part is taken.

CREATE TABLE `anomaly_dismissals` (
    `id` BINARY(16) NOT NULL,
    `company_id` BINARY(16) NOT NULL,
    -- The anomaly's stable identity: its code, plus whatever it is about.
    -- `anomaly.low_stock:<product hex>` names one product; a rule about the
    -- whole shop carries the code alone.
    `anomaly_key` VARCHAR(160) NOT NULL,
    `dismissed_by_id` BINARY(16) NOT NULL,
    `dismissed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    -- Seven days from the dismissal. Stored rather than derived so changing
    -- the window later cannot silently re-suppress or un-suppress anything
    -- somebody already dismissed under the old one.
    `suppressed_until` DATETIME(3) NOT NULL,

    -- The read path: "is this key suppressed for this company right now?".
    INDEX `anomaly_dismissals_company_id_anomaly_key_suppressed_until_idx`(`company_id`, `anomaly_key`, `suppressed_until`),
    -- The retention sweep: 90 days, dropped on read. An anomaly is a prompt,
    -- not a record.
    INDEX `anomaly_dismissals_dismissed_at_idx`(`dismissed_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;


ALTER TABLE `anomaly_dismissals` ADD CONSTRAINT `anomaly_dismissals_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `anomaly_dismissals` ADD CONSTRAINT `anomaly_dismissals_dismissed_by_id_fkey` FOREIGN KEY (`dismissed_by_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
