-- Idempotent receiving.
--
-- `POST /purchases` had no request identity, so a client retry after a timeout
-- created a SECOND purchase: duplicate stock, duplicate supplier payable, and a
-- second recognition-teaching pass that inflated `confirmations` for the same
-- logical action.
--
-- Mirrors the existing `sales.client_uuid` convention rather than introducing a
-- second idempotency mechanism, with two deliberate differences:
--
--   * the unique key is (company_id, client_uuid), NOT client_uuid alone, so one
--     company's key can never suppress another company's purchase;
--   * a payload fingerprint is stored, so replaying a key with DIFFERENT content
--     can be rejected as a conflict instead of silently returning the wrong
--     original result.
--
-- Both columns are NULLable and the unique index ignores NULLs in MySQL, so
-- existing rows and any client that omits the key are unaffected.
--
-- Reverse (safe, no data loss — the columns hold only request metadata):
--   ALTER TABLE `purchases` DROP INDEX `purchases_company_client_uuid_key`;
--   ALTER TABLE `purchases` DROP COLUMN `client_request_hash`;
--   ALTER TABLE `purchases` DROP COLUMN `client_uuid`;

ALTER TABLE `purchases`
  ADD COLUMN `client_uuid` BINARY(16) NULL,
  ADD COLUMN `client_request_hash` CHAR(64) NULL;

CREATE UNIQUE INDEX `purchases_company_client_uuid_key`
  ON `purchases` (`company_id`, `client_uuid`);
