-- ===========================================================================
-- 0010_recognition_stats — richer learning statistics (2C.5d)
--   The scanner is a company learning system: confidence must consider more
--   than times_seen. These denormalized counters feed a pluggable
--   ConfidenceScorer from a single fast row read (no audit-log aggregation on
--   the scan hot path). Additive only — existing rows default cleanly.
--     confirmations/corrections   → how often the mapping was affirmed vs fixed
--     last_confirmed_at/_corrected → recency signals
--     source_stats (JSON)         → per-source counts, e.g. {"receiving":5,...}
-- ===========================================================================

ALTER TABLE `product_recognition`
  ADD COLUMN `confirmations`     INT         NOT NULL DEFAULT 0 AFTER `times_seen`,
  ADD COLUMN `corrections`       INT         NOT NULL DEFAULT 0 AFTER `confirmations`,
  ADD COLUMN `last_confirmed_at` DATETIME(6) NULL     AFTER `last_seen_at`,
  ADD COLUMN `last_corrected_at` DATETIME(6) NULL     AFTER `last_confirmed_at`,
  ADD COLUMN `source_stats`      JSON        NULL     AFTER `last_corrected_at`;
