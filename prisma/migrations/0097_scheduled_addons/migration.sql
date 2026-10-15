-- ===========================================================================
-- 0097 — A store or paid seat confirmed during a running free trial is SCHEDULED, and joins the first paid period
--        when the trial ends (D176; the owner's correction of 2026-10-15; docs/76).
--
-- Why: during the trial the Owner may ask for another store or a paid seat, and the Super Admin may record its
-- payment — but nothing may be charged twice, and nothing paid for may run before the trial ends. Until now a
-- confirmed request became `paid` at once: the store opened mid-trial, the seat counted at once, and the first paid
-- period then assessed the same month again (review finding R1-F1: 1500 MRU for one store-month). A confirmation
-- during a running trial now leaves the request `scheduled`: paid, not in force, and counted nowhere — not by the
-- census, not by billing, not by a seat check — until `effective_at`, the trial's end. Then, once a paid period is in
-- force, the request becomes `paid`, the store opens, and that period is raised by exactly this request, once.
--
-- seat_allocations.status gains `scheduled`, APPENDED: no stored value moves. Every reader that counts seats or
--   stores names `paid`/`granted` explicitly, so a scheduled row fails closed everywhere (0086's census, refuse,
--   withdraw and release accept no `scheduled` row).
-- seat_allocations.effective_at: for a scheduled row, the claim's `ends_at`, copied under the subscription lock at
--   the confirmation (`trial_claims.ends_at` is immutable, 0095); once the row is in force, the instant it took
--   effect — the later of that end and the start of the paid period it joined. NULL for every other row: every row
--   that exists today, and every confirmation that takes effect at once, did so at `confirmed_at`.
-- ck_seat_alloc_scheduled: a scheduled row always has its instant, and is a seat or a store. A CHECK, as 0095's are,
--   because it binds every account whatever this server's empty sql_mode; Prisma does not model it. It cannot name
--   `payment_id`: MySQL refuses a CHECK on a column a foreign key's referential action writes (error 3823 —
--   `fk_seat_alloc_payment` is ON DELETE SET NULL ON UPDATE CASCADE; found by the rehearsal). The payment is held by
--   the one writer of the status instead: the confirmation sets the status, the payment and the instant in one
--   guarded UPDATE, beside the payment row it inserts in the same transaction, reads all three back, and rolls both
--   back unless they are what it wrote.
--
-- No new index: `ix_seat_alloc_status_requested (status, requested_at)` serves the sweeper's `status = 'scheduled'`
-- prefix and `ix_seat_alloc_company_status (company_id, status)` the per-company checks (0086). No backfill, and no
-- data precondition: no existing row can hold the new value.
--
-- Additive. The API must ship with it: an older API's Prisma client cannot read a `scheduled` row, so roll the API
-- back only while no row is `scheduled` — otherwise roll forward.
--
-- Reverse — only while no row is scheduled (SELECT COUNT(*) FROM `seat_allocations` WHERE `status` = 'scheduled'
-- must answer 0; this server's empty sql_mode would otherwise blank those statuses to ''):
--   ALTER TABLE `seat_allocations` DROP CHECK `ck_seat_alloc_scheduled`;
--   ALTER TABLE `seat_allocations` DROP COLUMN `effective_at`;
--   ALTER TABLE `seat_allocations` MODIFY `status` ENUM('pending_payment','paid','granted','released','refused') NOT NULL DEFAULT 'pending_payment';
-- ===========================================================================

-- 1. One ENUM value, APPENDED: no stored value moves (the 0096 precedent) ------------------------------------------
ALTER TABLE `seat_allocations`
  MODIFY `status` ENUM('pending_payment','paid','granted','released','refused','scheduled') NOT NULL DEFAULT 'pending_payment';

-- 2. When a scheduled request takes effect, and when one already did --------------------------------------------
ALTER TABLE `seat_allocations` ADD COLUMN `effective_at` DATETIME(6) NULL AFTER `confirmed_at`;

-- 3. A scheduled row always has its instant, and is a seat or a store -------------------------------------------
ALTER TABLE `seat_allocations` ADD CONSTRAINT `ck_seat_alloc_scheduled`
  CHECK (`status` <> 'scheduled' OR (`effective_at` IS NOT NULL AND `kind` IN ('seat','store')));
