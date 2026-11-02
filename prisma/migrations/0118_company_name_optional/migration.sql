-- ===========================================================================
-- 0118_company_name_optional (D227, the owner's decision of 2026-11-02)
--
-- Most customers are individual shop owners with no company name. `companies`
-- stays the tenant boundary; `name` and `name_ar` become the one optional
-- registered/trading name. Nothing is backfilled or invented: existing values are
-- untouched and keep showing as the trading name, and a new account may have none.
--
-- Additive in effect: an older build always sends a name and reads this column.
-- Reverse, only while every row has a name:
--   ALTER TABLE companies MODIFY name VARCHAR(160) NOT NULL;
-- ===========================================================================

ALTER TABLE `companies` MODIFY `name` VARCHAR(160) NULL;
ALTER TABLE `registration_attempts` MODIFY `business_name` VARCHAR(160) NULL;
