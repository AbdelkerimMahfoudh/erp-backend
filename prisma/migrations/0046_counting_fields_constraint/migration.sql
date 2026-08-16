-- 0046 — correct a constraint 0045 got wrong
--
-- ## What the live run found
--
-- `ck_closings_counted_fields` was written as:
--
--   CHECK ((status = 'counting') = (counted_at IS NULL))
--
-- which says: a day still being counted has nobody's count on it. That reads
-- plausibly and is wrong, and progressive counting is exactly what exposes it.
--
-- A day is `counting` until every channel has been counted or skipped. So a
-- shop that has counted the drawer but not yet checked its Bankily balance is
-- legitimately BOTH `counting` AND holding a real, attributed count — which the
-- constraint refused. The first count against a multi-channel day failed with
-- MySQL 3819, and no unit test could have caught it: the rule only breaks when
-- a real second channel exists.
--
-- ## What was actually meant
--
-- Two rules, and 0045 collapsed them into one wrong one:
--
--   1. The WHO and the WHEN travel together. A recorded count says who entered
--      it and when, or claims neither. Half of an attribution is worse than
--      none — it makes a count look attributed when nobody can be asked.
--
--   2. Finishing implies having started. A day cannot reach `counted` with no
--      count on it at all.
--
-- Note what is deliberately NOT asserted: that `counting` implies no count.
-- That is the thing being fixed.
--
-- Rerun-safe: guarded both ways.

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'daily_closings'
      AND constraint_name = 'ck_closings_counted_fields') > 0,
  'ALTER TABLE `daily_closings` DROP CHECK `ck_closings_counted_fields`',
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- 1. Who and when, together or not at all.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'daily_closings'
      AND constraint_name = 'ck_closings_count_attribution') = 0,
  'ALTER TABLE `daily_closings` ADD CONSTRAINT `ck_closings_count_attribution`
     CHECK ((`counted_at` IS NULL) = (`counted_by_id` IS NULL))',
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- 2. `counted` means somebody counted. A day cannot finish counting without
--    having counted, and existing pre-0045 rows are `locked`, so none of them
--    is affected.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'daily_closings'
      AND constraint_name = 'ck_closings_counted_started') = 0,
  "ALTER TABLE `daily_closings` ADD CONSTRAINT `ck_closings_counted_started`
     CHECK (`status` <> 'counted' OR `counted_at` IS NOT NULL)",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- Reverse SQL (not executed):
--   ALTER TABLE `daily_closings`
--     DROP CHECK `ck_closings_count_attribution`,
--     DROP CHECK `ck_closings_counted_started`,
--     ADD CONSTRAINT `ck_closings_counted_fields`
--       CHECK ((`status` = 'counting') = (`counted_at` IS NULL));
