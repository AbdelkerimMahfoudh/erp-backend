-- ===========================================================================
-- 0007_products_categories — generalize catalog for Electronics Retail (2C.5a)
--   * product_categories (with default_tracking_type + adaptive attribute_schema)
--   * products: tracking_type, category_id, specifications, barcode
--     (drop old `category` enum + `is_serialized` after backfilling tracking_type)
--   * product_recognition (the learning map; serial_prefix reserved for future)
-- ===========================================================================

-- 1. Categories -------------------------------------------------------------
CREATE TABLE `product_categories` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `name` VARCHAR(80) NOT NULL,
  `default_tracking_type` ENUM('imei','serial','quantity') NOT NULL,
  `attribute_schema` JSON NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `product_categories_company_id_name_key` (`company_id`,`name`),
  KEY `product_categories_company_id_idx` (`company_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
ALTER TABLE `product_categories` ADD CONSTRAINT `product_categories_company_id_fkey`
  FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. Products: new columns --------------------------------------------------
ALTER TABLE `products`
  ADD COLUMN `tracking_type` ENUM('imei','serial','quantity') NOT NULL DEFAULT 'imei' AFTER `category`,
  ADD COLUMN `category_id` BINARY(16) NULL AFTER `company_id`,
  ADD COLUMN `specifications` JSON NULL,
  ADD COLUMN `barcode` VARCHAR(64) NULL;

-- 3. Backfill tracking_type from the old enum, then drop the old columns -----
UPDATE `products` SET `tracking_type` = IF(`category` = 'accessory', 'quantity', 'imei');
CREATE UNIQUE INDEX `products_company_id_barcode_key` ON `products`(`company_id`,`barcode`);
ALTER TABLE `products` DROP COLUMN `category`, DROP COLUMN `is_serialized`;

-- 4. Category FK ------------------------------------------------------------
CREATE INDEX `products_category_id_idx` ON `products`(`category_id`);
ALTER TABLE `products` ADD CONSTRAINT `products_category_id_fkey`
  FOREIGN KEY (`category_id`) REFERENCES `product_categories`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- 5. Learning map -----------------------------------------------------------
CREATE TABLE `product_recognition` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `code_type` ENUM('tac','barcode','serial_prefix') NOT NULL,
  `code` VARCHAR(64) NOT NULL,
  `product_id` BINARY(16) NOT NULL,
  `times_seen` INT NOT NULL DEFAULT 1,
  `last_seen_at` DATETIME(6) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `product_recognition_company_id_code_type_code_key` (`company_id`,`code_type`,`code`),
  KEY `product_recognition_company_id_product_id_idx` (`company_id`,`product_id`),
  KEY `product_recognition_product_id_idx` (`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
ALTER TABLE `product_recognition` ADD CONSTRAINT `product_recognition_company_id_fkey`
  FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `product_recognition` ADD CONSTRAINT `product_recognition_product_id_fkey`
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
