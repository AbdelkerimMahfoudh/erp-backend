-- D227: a store's choice to treat a money location as dedicated to it. Additive: no row means OFF, for every existing account.
-- Reverse: DROP TABLE money_location_tracking.
CREATE TABLE `money_location_tracking` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `branch_id` BINARY(16) NOT NULL,
  `location` VARCHAR(36) NOT NULL,
  `is_on` TINYINT(1) NOT NULL DEFAULT 0,
  `opening_amount` DECIMAL(14,2) NULL,
  `effective_date` DATE NULL,
  `version` INT NOT NULL DEFAULT 0,
  `updated_by` BINARY(16) NULL,
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_money_tracking_location` (`branch_id`, `location`),
  CONSTRAINT `fk_money_tracking_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_money_tracking_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
