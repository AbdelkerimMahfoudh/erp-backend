-- Milestone J — a queued report must not be able to lie about its own payload.
--
-- `loan_ledger` and `consignment_ledger` already carried `client_uuid`, and
-- their replay logic returned the existing row for ANY request bearing that
-- key. Online and immediate, that is harmless. Behind an offline queue it is
-- not: edit a queued payment report from 5,000 to 8,000, reuse the key, and the
-- server would silently return the original 5,000 row while the phone displayed
-- "synced". The shop would believe it had reported 8,000.
--
-- `expenses` already did this correctly (0038). These two now match it, so all
-- three queueable report endpoints refuse a changed payload with a 409 instead
-- of quietly answering about a different amount.
--
-- Nullable, because every row written before this migration has no fingerprint
-- and must keep replaying as it always did rather than becoming a conflict.

ALTER TABLE `loan_ledger`
  ADD COLUMN `client_request_hash` CHAR(64) NULL AFTER `client_uuid`;

ALTER TABLE `consignment_ledger`
  ADD COLUMN `client_request_hash` CHAR(64) NULL AFTER `client_uuid`;
