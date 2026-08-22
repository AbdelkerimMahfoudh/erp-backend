-- CP3 — a personal login ID for every user.
--
-- The audit (docs/35) found that **not one existing user has a phone number**.
-- A phone-only sign-in would have locked every account out of the product on
-- the day it shipped, so this column is not a convenience — it is currently the
-- only identifier most people here can sign in with.
--
-- Deliberately ONE column on the existing table. No second user model: there is
-- no global identity to reuse, and a parallel table would duplicate every
-- foreign key and every audit reference for nothing. Password hashes stay
-- exactly where they are — a globally searchable table of credentials is
-- precisely what an identity change must not create.

ALTER TABLE `users`
  ADD COLUMN `personal_id` CHAR(10) NULL AFTER `login`;

-- Backfill, deterministically from the primary key.
--
-- `U-` then 8 characters drawn from an alphabet with the ambiguous glyphs
-- removed: no I, L, O, U, 0 or 1, so nothing is misread off a handwritten note.
-- Starting with a letter means no phone normalisation can ever produce one.
--
-- Derived from SHA2 of the row's own id rather than from RAND(): a stored
-- procedure would be the obvious way to retry a collision, but Prisma's
-- migration runner splits on semicolons and cannot execute one. Deterministic
-- derivation needs no retry loop, is reproducible if this migration is ever
-- re-run against a restored dump, and the UNIQUE index added below is what
-- actually guarantees the result — if two rows ever did collide, this migration
-- fails loudly instead of quietly issuing a duplicate identifier.
--
-- 30^8 is about 6.6e11, so for any realistic number of users the chance of a
-- collision is negligible; "negligible" is not "impossible", which is why the
-- database, not this arithmetic, has the final say.
UPDATE `users`
SET `personal_id` = CONCAT(
  'U-',
  SUBSTRING('23456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + (CONV(SUBSTRING(SHA2(HEX(`id`), 256),  1, 2), 16, 10) % 30), 1),
  SUBSTRING('23456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + (CONV(SUBSTRING(SHA2(HEX(`id`), 256),  3, 2), 16, 10) % 30), 1),
  SUBSTRING('23456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + (CONV(SUBSTRING(SHA2(HEX(`id`), 256),  5, 2), 16, 10) % 30), 1),
  SUBSTRING('23456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + (CONV(SUBSTRING(SHA2(HEX(`id`), 256),  7, 2), 16, 10) % 30), 1),
  SUBSTRING('23456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + (CONV(SUBSTRING(SHA2(HEX(`id`), 256),  9, 2), 16, 10) % 30), 1),
  SUBSTRING('23456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + (CONV(SUBSTRING(SHA2(HEX(`id`), 256), 11, 2), 16, 10) % 30), 1),
  SUBSTRING('23456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + (CONV(SUBSTRING(SHA2(HEX(`id`), 256), 13, 2), 16, 10) % 30), 1),
  SUBSTRING('23456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + (CONV(SUBSTRING(SHA2(HEX(`id`), 256), 15, 2), 16, 10) % 30), 1)
)
WHERE `personal_id` IS NULL;

-- Now that every row has one, make it required and unique.
--
-- Globally unique, not per company: the whole point is that somebody can sign
-- in without naming their shop first, so the identifier has to resolve on its
-- own. Enforced by the database rather than by application code, because two
-- concurrent creations racing on the same code is exactly the case an
-- application-level check misses.
ALTER TABLE `users`
  MODIFY COLUMN `personal_id` CHAR(10) NOT NULL;

ALTER TABLE `users`
  ADD UNIQUE KEY `ux_users_personal_id` (`personal_id`);
