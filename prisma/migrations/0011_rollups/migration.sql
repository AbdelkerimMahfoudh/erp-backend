-- ===========================================================================
-- 0011_rollups — analytics rollup/cache tables (Sprint 2D)
--   Derived from sale_items/units/stock_items; rebuildable, so NO FK
--   constraints. Analytics are tracking-type INDEPENDENT — every figure comes
--   from sale_items; category_id + tracking_type are denormalized for fast
--   grouping by category / tracking type.
--     daily_rollups          — store totals per branch/day
--     product_daily_rollups  — per-product fact (any tracking type)
--     product_velocity       — movement / dead-stock signal (filled in 2D.2)
--     inventory_valuation    — $ invested + expected profit (filled in 2D.2)
-- ===========================================================================

CREATE TABLE `daily_rollups` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `branch_id` BINARY(16) NOT NULL,
  `day` DATE NOT NULL,
  `revenue` DECIMAL(14,2) NOT NULL,
  `cogs` DECIMAL(14,2) NOT NULL,
  `gross_profit` DECIMAL(14,2) NOT NULL,
  `sales_count` INT NOT NULL,
  `qty_sold` INT NOT NULL,
  `expenses` DECIMAL(14,2) NOT NULL,
  `net_profit` DECIMAL(14,2) NOT NULL,
  `refreshed_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `daily_rollups_branch_id_day_key` (`branch_id`,`day`),
  KEY `daily_rollups_company_id_day_idx` (`company_id`,`day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `product_daily_rollups` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `branch_id` BINARY(16) NOT NULL,
  `day` DATE NOT NULL,
  `product_id` BINARY(16) NOT NULL,
  `category_id` BINARY(16) NULL,
  `tracking_type` ENUM('imei','serial','quantity') NOT NULL,
  `qty_sold` INT NOT NULL,
  `revenue` DECIMAL(14,2) NOT NULL,
  `cogs` DECIMAL(14,2) NOT NULL,
  `gross_profit` DECIMAL(14,2) NOT NULL,
  `refreshed_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `product_daily_rollups_branch_id_day_product_id_key` (`branch_id`,`day`,`product_id`),
  KEY `product_daily_rollups_company_id_day_idx` (`company_id`,`day`),
  KEY `product_daily_rollups_company_id_category_id_day_idx` (`company_id`,`category_id`,`day`),
  KEY `product_daily_rollups_company_id_tracking_type_day_idx` (`company_id`,`tracking_type`,`day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `product_velocity` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `branch_id` BINARY(16) NOT NULL,
  `product_id` BINARY(16) NOT NULL,
  `sold_7d` INT NOT NULL DEFAULT 0,
  `sold_30d` INT NOT NULL DEFAULT 0,
  `last_sold_at` DATETIME(6) NULL,
  `refreshed_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `product_velocity_company_id_branch_id_product_id_key` (`company_id`,`branch_id`,`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `inventory_valuation` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `branch_id` BINARY(16) NOT NULL,
  `product_id` BINARY(16) NOT NULL,
  `category_id` BINARY(16) NULL,
  `tracking_type` ENUM('imei','serial','quantity') NOT NULL,
  `units_count` INT NOT NULL DEFAULT 0,
  `quantity` INT NOT NULL DEFAULT 0,
  `inventory_value` DECIMAL(14,2) NOT NULL,
  `expected_revenue` DECIMAL(14,2) NOT NULL,
  `expected_profit` DECIMAL(14,2) NOT NULL,
  `refreshed_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `inventory_valuation_company_id_branch_id_product_id_key` (`company_id`,`branch_id`,`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
