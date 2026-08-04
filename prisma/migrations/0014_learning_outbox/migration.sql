-- Durable recognition learning + company-scoped sale idempotency.
--
-- 1) LEARNING OUTBOX
--
-- Teach-on-confirm ran AFTER the purchase transaction committed. If the process
-- stopped in that window the purchase survived and the learning was lost
-- permanently — the shop received stock the scanner never learned from.
--
-- The intent is now written INSIDE the same transaction as the purchase, so
-- either both exist or neither does. A sweeper processes rows afterwards.
--
-- Idempotency is structural: UNIQUE (company_id, purchase_id, code_type, code)
-- means one logical learning event per code per delivery. Re-running the sweep,
-- or retrying a purchase, cannot enqueue a second copy and therefore cannot
-- increment `confirmations` twice. Rows are never deleted, so genuinely repeated
-- confirmations under DIFFERENT purchases remain separate evidence.
--
-- `status`/`attempts`/`last_error` keep failures observable and retryable
-- rather than silently dropped.
--
-- 2) SALE IDEMPOTENCY SCOPE
--
-- `sales.client_uuid` was globally unique, so in principle one company's key
-- could block another company's sale. Re-scoped to (company_id, client_uuid),
-- matching the purchases convention from 0013.
--
-- Reverse (safe — the outbox holds only queued side-effect metadata):
--   DROP TABLE `recognition_outbox`;
--   ALTER TABLE `sales` DROP INDEX `sales_company_client_uuid_key`;
--   CREATE UNIQUE INDEX `sales_client_uuid_key` ON `sales` (`client_uuid`);

CREATE TABLE `recognition_outbox` (
  `id`          BINARY(16)  NOT NULL,
  `company_id`  BINARY(16)  NOT NULL,
  `purchase_id` BINARY(16)  NULL,
  `code_type`   VARCHAR(16) NOT NULL,
  `code`        VARCHAR(64) NOT NULL,
  `product_id`  BINARY(16)  NOT NULL,
  `supplier_id` BINARY(16)  NULL,
  `source`      VARCHAR(32) NOT NULL,
  `status`      VARCHAR(16) NOT NULL DEFAULT 'pending',
  `attempts`    INT         NOT NULL DEFAULT 0,
  `last_error`  VARCHAR(500) NULL,
  `created_at`  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `processed_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `recognition_outbox_event_key` (`company_id`, `purchase_id`, `code_type`, `code`),
  KEY `recognition_outbox_status_idx` (`status`, `updated_at`),
  CONSTRAINT `recognition_outbox_company_fk` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE `sales` DROP INDEX `sales_client_uuid_key`;
CREATE UNIQUE INDEX `sales_company_client_uuid_key` ON `sales` (`company_id`, `client_uuid`);
