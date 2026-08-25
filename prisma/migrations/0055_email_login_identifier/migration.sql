-- Email becomes a sign-in identifier.
--
-- Until now `email` was optional recovery information with no uniqueness at
-- all (docs/23 §4 deferred it deliberately). A login identifier cannot stay
-- that way: without the constraint, two rows could hold the same address and
-- the password check would have to choose between them.
--
-- Per COMPANY, not global — exactly the rule `phone` already carries. One
-- address used at two shops is a real situation, and it must keep reaching the
-- password-first account chooser rather than being refused at enrolment.
--
-- Safe on existing data: every current row has `email IS NULL`, and MySQL
-- allows any number of NULLs in a unique index.
ALTER TABLE `users`
  ADD UNIQUE KEY `ux_users_company_email` (`company_id`, `email`);
