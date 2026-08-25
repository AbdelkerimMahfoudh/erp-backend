-- The lifecycle needs event kinds the enum does not have.
--
-- `subscription_events.kind` is an ENUM constrained to Milestone K's vocabulary,
-- while `schema.prisma` declares it as a plain `String`. Nothing reconciled the
-- two, so writing a new kind was accepted by Prisma, silently coerced to '' by
-- MySQL — this server runs with an EMPTY sql_mode — and stored as a blank.
--
-- Found by the live check, not by a unit test: the row was created, the request
-- succeeded, and only reading the row back showed the kind was gone.
--
-- `complimentary_granted` already exists and keeps its meaning; the new members
-- name the transitions that had no vocabulary at all.
ALTER TABLE `subscription_events`
  MODIFY COLUMN `kind` ENUM(
    'created',
    'extended',
    'branches_changed',
    'seats_changed',
    'complimentary_granted',
    'complimentary_revoked',
    'backfilled',
    -- 0057: the self-service and administrator lifecycle.
    'registered',
    'administrative_grant',
    'suspended',
    'reinstated',
    'cancelled'
  ) NOT NULL;
