-- ===========================================================================
-- 0001_init — MySQL 8 base schema (tables, enums, unique/plain indexes, FKs)
-- Engine: InnoDB · Charset: utf8mb4 · PKs: BINARY(16) UUIDv7 (app-generated)
-- MySQL-specific extras (generated columns, FULLTEXT, CHECK, grants) → 0002.
-- ===========================================================================

-- ------------------------------- Tables -----------------------------------

CREATE TABLE `companies` (
  `id` BINARY(16) NOT NULL,
  `name` VARCHAR(160) NOT NULL,
  `currency` CHAR(3) NOT NULL DEFAULT 'USD',
  `timezone` VARCHAR(64) NOT NULL DEFAULT 'UTC',
  `settings` JSON NOT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `branches` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `name` VARCHAR(160) NOT NULL,
  `type` ENUM('store','warehouse') NOT NULL DEFAULT 'store',
  `address` VARCHAR(255) NULL,
  `phone` VARCHAR(40) NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  `deleted_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `branches_company_id_name_key` (`company_id`,`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `users` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `name` VARCHAR(160) NOT NULL,
  `login` VARCHAR(120) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `pin_hash` VARCHAR(255) NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `last_login_at` DATETIME(6) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  `deleted_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `users_company_id_login_key` (`company_id`,`login`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `roles` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `key` ENUM('owner','administrator','branch_manager','sales_employee','warehouse_employee') NOT NULL,
  `name` VARCHAR(80) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `roles_company_id_key_key` (`company_id`,`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `permissions` (
  `id` BINARY(16) NOT NULL,
  `key` VARCHAR(80) NOT NULL,
  `label` VARCHAR(160) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `permissions_key_key` (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `role_permissions` (
  `company_id` BINARY(16) NOT NULL,
  `role_id` BINARY(16) NOT NULL,
  `permission_id` BINARY(16) NOT NULL,
  PRIMARY KEY (`role_id`,`permission_id`),
  KEY `role_permissions_company_id_idx` (`company_id`),
  KEY `role_permissions_permission_id_idx` (`permission_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `user_branches` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `user_id` BINARY(16) NOT NULL,
  `branch_id` BINARY(16) NOT NULL,
  `role_id` BINARY(16) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `user_branches_user_id_branch_id_key` (`user_id`,`branch_id`),
  KEY `user_branches_company_id_idx` (`company_id`),
  KEY `user_branches_branch_id_idx` (`branch_id`),
  KEY `user_branches_role_id_idx` (`role_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `products` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `brand` VARCHAR(80) NOT NULL,
  `model` VARCHAR(120) NOT NULL,
  `variant` VARCHAR(120) NULL,
  `category` ENUM('phone','accessory','other') NOT NULL DEFAULT 'phone',
  `is_serialized` TINYINT(1) NOT NULL DEFAULT 1,
  `default_cost` DECIMAL(14,2) NULL,
  `default_price` DECIMAL(14,2) NULL,
  `reorder_threshold` INT NOT NULL DEFAULT 0,
  `tax_rate` DECIMAL(6,4) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  `deleted_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `products_company_id_brand_model_variant_key` (`company_id`,`brand`,`model`,`variant`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `tac_catalog` (
  `tac` CHAR(8) NOT NULL,
  `brand` VARCHAR(80) NULL,
  `model` VARCHAR(120) NULL,
  `default_variant` VARCHAR(120) NULL,
  PRIMARY KEY (`tac`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `units` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `product_id` BINARY(16) NOT NULL,
  `branch_id` BINARY(16) NOT NULL,
  `supplier_id` BINARY(16) NULL,
  `purchase_id` BINARY(16) NULL,
  `imei_primary` VARCHAR(15) NOT NULL,
  `imei_secondary` VARCHAR(15) NULL,
  `serial_no` VARCHAR(60) NULL,
  `cost` DECIMAL(14,2) NOT NULL,
  `status` ENUM('in_stock','reserved','sold','returned','faulty','in_transit','transferred_out') NOT NULL DEFAULT 'in_stock',
  `date_in` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `date_sold` DATETIME(6) NULL,
  `image_ref` VARCHAR(512) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  `created_by` BINARY(16) NULL,
  `updated_by` BINARY(16) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `units_imei_primary_key` (`imei_primary`),
  UNIQUE KEY `units_imei_secondary_key` (`imei_secondary`),
  KEY `units_company_id_branch_id_status_idx` (`company_id`,`branch_id`,`status`),
  KEY `units_product_id_idx` (`product_id`),
  KEY `units_supplier_id_idx` (`supplier_id`),
  KEY `units_purchase_id_idx` (`purchase_id`),
  KEY `units_created_by_idx` (`created_by`),
  KEY `units_updated_by_idx` (`updated_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `stock_items` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `product_id` BINARY(16) NOT NULL,
  `branch_id` BINARY(16) NOT NULL,
  `quantity` INT NOT NULL DEFAULT 0,
  `cost` DECIMAL(14,2) NOT NULL,
  `price` DECIMAL(14,2) NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `stock_items_company_id_product_id_branch_id_key` (`company_id`,`product_id`,`branch_id`),
  KEY `stock_items_product_id_idx` (`product_id`),
  KEY `stock_items_branch_id_idx` (`branch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `suppliers` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `name` VARCHAR(160) NOT NULL,
  `phone` VARCHAR(40) NULL,
  `notes` TEXT NULL,
  `balance` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  `deleted_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `suppliers_company_id_name_key` (`company_id`,`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `purchases` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `branch_id` BINARY(16) NOT NULL,
  `supplier_id` BINARY(16) NOT NULL,
  `user_id` BINARY(16) NULL,
  `reference_no` VARCHAR(40) NULL,
  `date` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `subtotal` DECIMAL(14,2) NOT NULL,
  `tax_total` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `total` DECIMAL(14,2) NOT NULL,
  `amount_paid` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `status` ENUM('paid','partial','unpaid') NOT NULL DEFAULT 'unpaid',
  `due_date` DATE NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `purchases_company_id_branch_id_date_idx` (`company_id`,`branch_id`,`date`),
  KEY `purchases_supplier_id_idx` (`supplier_id`),
  KEY `purchases_user_id_idx` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `purchase_items` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `purchase_id` BINARY(16) NOT NULL,
  `product_id` BINARY(16) NOT NULL,
  `quantity` INT NOT NULL,
  `unit_cost` DECIMAL(14,2) NOT NULL,
  `tax_amount` DECIMAL(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `purchase_items_purchase_id_idx` (`purchase_id`),
  KEY `purchase_items_company_id_idx` (`company_id`),
  KEY `purchase_items_product_id_idx` (`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `supplier_payments` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `supplier_id` BINARY(16) NOT NULL,
  `purchase_id` BINARY(16) NULL,
  `amount` DECIMAL(14,2) NOT NULL,
  `method` ENUM('cash','card','mobile','bank','other') NOT NULL,
  `paid_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` BINARY(16) NULL,
  PRIMARY KEY (`id`),
  KEY `supplier_payments_company_id_supplier_id_idx` (`company_id`,`supplier_id`),
  KEY `supplier_payments_purchase_id_idx` (`purchase_id`),
  KEY `supplier_payments_created_by_idx` (`created_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `customers` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `name` VARCHAR(160) NULL,
  `phone` VARCHAR(40) NULL,
  `notes` TEXT NULL,
  `balance` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  `deleted_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`),
  KEY `customers_company_id_idx` (`company_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `sales` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `branch_id` BINARY(16) NOT NULL,
  `user_id` BINARY(16) NOT NULL,
  `customer_id` BINARY(16) NULL,
  `invoice_no` VARCHAR(24) NOT NULL,
  `sold_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `subtotal` DECIMAL(14,2) NOT NULL,
  `discount` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `tax_total` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `total` DECIMAL(14,2) NOT NULL,
  `total_cost` DECIMAL(14,2) NOT NULL,
  `margin` DECIMAL(14,2) NOT NULL,
  `amount_paid` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `balance_due` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `pay_status` ENUM('paid','partial','credit') NOT NULL DEFAULT 'paid',
  `due_date` DATE NULL,
  `is_reversed` TINYINT(1) NOT NULL DEFAULT 0,
  `client_uuid` BINARY(16) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `sales_branch_id_invoice_no_key` (`branch_id`,`invoice_no`),
  UNIQUE KEY `sales_client_uuid_key` (`client_uuid`),
  KEY `sales_company_id_branch_id_sold_at_idx` (`company_id`,`branch_id`,`sold_at`),
  KEY `sales_company_id_user_id_sold_at_idx` (`company_id`,`user_id`,`sold_at`),
  KEY `sales_customer_id_idx` (`customer_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `sale_items` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `sale_id` BINARY(16) NOT NULL,
  `unit_id` BINARY(16) NULL,
  `product_id` BINARY(16) NULL,
  `quantity` INT NOT NULL DEFAULT 1,
  `price` DECIMAL(14,2) NOT NULL,
  `cost` DECIMAL(14,2) NOT NULL,
  `discount` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `tax_amount` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `voided` TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `sale_items_sale_id_idx` (`sale_id`),
  KEY `sale_items_company_id_idx` (`company_id`),
  KEY `sale_items_unit_id_idx` (`unit_id`),
  KEY `sale_items_product_id_idx` (`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `payments` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `sale_id` BINARY(16) NOT NULL,
  `method` ENUM('cash','card','mobile','bank','other') NOT NULL,
  `amount` DECIMAL(14,2) NOT NULL,
  `paid_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `payments_sale_id_idx` (`sale_id`),
  KEY `payments_company_id_idx` (`company_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `returns` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `sale_id` BINARY(16) NOT NULL,
  `sale_item_id` BINARY(16) NULL,
  `unit_id` BINARY(16) NULL,
  `reason` VARCHAR(255) NULL,
  `refund_amount` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `restock` TINYINT(1) NOT NULL DEFAULT 1,
  `returned_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` BINARY(16) NULL,
  PRIMARY KEY (`id`),
  KEY `returns_company_id_sale_id_idx` (`company_id`,`sale_id`),
  KEY `returns_sale_item_id_idx` (`sale_item_id`),
  KEY `returns_unit_id_idx` (`unit_id`),
  KEY `returns_created_by_idx` (`created_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `stock_transfers` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `from_branch_id` BINARY(16) NOT NULL,
  `to_branch_id` BINARY(16) NOT NULL,
  `status` ENUM('in_transit','received','cancelled') NOT NULL DEFAULT 'in_transit',
  `sent_by` BINARY(16) NULL,
  `received_by` BINARY(16) NULL,
  `sent_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `received_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`),
  KEY `stock_transfers_company_id_idx` (`company_id`),
  KEY `stock_transfers_from_branch_id_idx` (`from_branch_id`),
  KEY `stock_transfers_to_branch_id_idx` (`to_branch_id`),
  KEY `stock_transfers_sent_by_idx` (`sent_by`),
  KEY `stock_transfers_received_by_idx` (`received_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `transfer_items` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `transfer_id` BINARY(16) NOT NULL,
  `unit_id` BINARY(16) NULL,
  `product_id` BINARY(16) NULL,
  `quantity` INT NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  KEY `transfer_items_transfer_id_idx` (`transfer_id`),
  KEY `transfer_items_company_id_idx` (`company_id`),
  KEY `transfer_items_unit_id_idx` (`unit_id`),
  KEY `transfer_items_product_id_idx` (`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `expense_templates` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `branch_id` BINARY(16) NULL,
  `category` VARCHAR(60) NOT NULL,
  `amount` DECIMAL(14,2) NOT NULL,
  `recurrence` ENUM('none','monthly','yearly') NOT NULL DEFAULT 'monthly',
  `day_of_month` SMALLINT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  KEY `expense_templates_company_id_idx` (`company_id`),
  KEY `expense_templates_branch_id_idx` (`branch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `expenses` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `branch_id` BINARY(16) NULL,
  `template_id` BINARY(16) NULL,
  `category` VARCHAR(60) NOT NULL,
  `amount` DECIMAL(14,2) NOT NULL,
  `spent_on` DATE NOT NULL,
  `note` TEXT NULL,
  `created_by` BINARY(16) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `expenses_company_id_branch_id_spent_on_idx` (`company_id`,`branch_id`,`spent_on`),
  KEY `expenses_template_id_idx` (`template_id`),
  KEY `expenses_created_by_idx` (`created_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `daily_closings` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `branch_id` BINARY(16) NOT NULL,
  `closing_date` DATE NOT NULL,
  `expected_cash` DECIMAL(14,2) NOT NULL,
  `counted_cash` DECIMAL(14,2) NOT NULL,
  `difference` DECIMAL(14,2) NOT NULL,
  `total_sales` DECIMAL(14,2) NOT NULL,
  `total_profit` DECIMAL(14,2) NOT NULL,
  `is_locked` TINYINT(1) NOT NULL DEFAULT 1,
  `notes` TEXT NULL,
  `closed_by` BINARY(16) NULL,
  `closed_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `daily_closings_branch_id_closing_date_key` (`branch_id`,`closing_date`),
  KEY `daily_closings_company_id_idx` (`company_id`),
  KEY `daily_closings_closed_by_idx` (`closed_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `daily_digests` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `branch_id` BINARY(16) NOT NULL,
  `closing_id` BINARY(16) NULL,
  `digest_date` DATE NOT NULL,
  `revenue` DECIMAL(14,2) NOT NULL,
  `cost_of_goods_sold` DECIMAL(14,2) NOT NULL,
  `gross_profit` DECIMAL(14,2) NOT NULL,
  `generated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `daily_digests_closing_id_key` (`closing_id`),
  UNIQUE KEY `daily_digests_branch_id_digest_date_key` (`branch_id`,`digest_date`),
  KEY `daily_digests_company_id_idx` (`company_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `digest_lines` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `digest_id` BINARY(16) NOT NULL,
  `imei` VARCHAR(15) NULL,
  `product_label` VARCHAR(200) NULL,
  `employee_id` BINARY(16) NULL,
  `sale_price` DECIMAL(14,2) NULL,
  `purchase_cost` DECIMAL(14,2) NULL,
  `profit` DECIMAL(14,2) NULL,
  `method` ENUM('cash','card','mobile','bank','other') NULL,
  `sold_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`),
  KEY `digest_lines_digest_id_idx` (`digest_id`),
  KEY `digest_lines_company_id_idx` (`company_id`),
  KEY `digest_lines_employee_id_idx` (`employee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `notifications` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `branch_id` BINARY(16) NULL,
  `target_user_id` BINARY(16) NULL,
  `type` VARCHAR(60) NOT NULL,
  `title` VARCHAR(200) NOT NULL,
  `body` TEXT NULL,
  `action_link` VARCHAR(255) NULL,
  `is_read` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `notifications_company_id_target_user_id_is_read_created_at_idx` (`company_id`,`target_user_id`,`is_read`,`created_at`),
  KEY `notifications_branch_id_idx` (`branch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `import_batches` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `branch_id` BINARY(16) NOT NULL,
  `user_id` BINARY(16) NULL,
  `file_ref` VARCHAR(512) NOT NULL,
  `status` ENUM('parsing','preview','committed','failed') NOT NULL DEFAULT 'parsing',
  `total_rows` INT NOT NULL DEFAULT 0,
  `valid_rows` INT NOT NULL DEFAULT 0,
  `error_rows` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `import_batches_company_id_idx` (`company_id`),
  KEY `import_batches_branch_id_idx` (`branch_id`),
  KEY `import_batches_user_id_idx` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `import_rows` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `batch_id` BINARY(16) NOT NULL,
  `row_number` INT NOT NULL,
  `raw` JSON NULL,
  `parsed` JSON NULL,
  `status` ENUM('valid','warning','error') NOT NULL,
  `message` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `import_rows_batch_id_idx` (`batch_id`),
  KEY `import_rows_company_id_idx` (`company_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `report_definitions` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `name` VARCHAR(160) NOT NULL,
  `type` VARCHAR(60) NOT NULL,
  `params` JSON NOT NULL,
  `owner_user_id` BINARY(16) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `report_definitions_company_id_idx` (`company_id`),
  KEY `report_definitions_owner_user_id_idx` (`owner_user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `report_snapshots` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `definition_id` BINARY(16) NOT NULL,
  `range_start` DATE NULL,
  `range_end` DATE NULL,
  `file_ref` VARCHAR(512) NULL,
  `generated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `report_snapshots_definition_id_idx` (`definition_id`),
  KEY `report_snapshots_company_id_idx` (`company_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `audit_logs` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `company_id` BINARY(16) NOT NULL,
  `branch_id` BINARY(16) NULL,
  `user_id` BINARY(16) NULL,
  `entity_type` VARCHAR(60) NOT NULL,
  `entity_id` BINARY(16) NULL,
  `action` ENUM('create','update','delete','status_change','override','login','logout') NOT NULL,
  `before` JSON NULL,
  `after` JSON NULL,
  `reason` TEXT NULL,
  `ip` VARCHAR(45) NULL,
  `at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `audit_logs_company_id_entity_type_entity_id_at_idx` (`company_id`,`entity_type`,`entity_id`,`at`),
  KEY `audit_logs_user_id_idx` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `settings` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `branch_id` BINARY(16) NULL,
  `key` VARCHAR(80) NOT NULL,
  `value` JSON NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `settings_company_id_branch_id_key_key` (`company_id`,`branch_id`,`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `sync_devices` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `user_id` BINARY(16) NOT NULL,
  `device_id` VARCHAR(120) NOT NULL,
  `last_pull_cursor` BIGINT NULL,
  `last_seen_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `sync_devices_user_id_device_id_key` (`user_id`,`device_id`),
  KEY `sync_devices_company_id_idx` (`company_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `outbox_changes` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `device_id` VARCHAR(120) NOT NULL,
  `entity_type` VARCHAR(60) NOT NULL,
  `entity_id` BINARY(16) NULL,
  `op` VARCHAR(20) NOT NULL,
  `payload` JSON NULL,
  `status` ENUM('pending','accepted','conflict','rejected') NOT NULL DEFAULT 'pending',
  `reason` TEXT NULL,
  `received_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `outbox_changes_company_id_status_idx` (`company_id`,`status`),
  KEY `outbox_changes_device_id_idx` (`device_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ----------------------------- Foreign keys --------------------------------
ALTER TABLE `branches` ADD CONSTRAINT `branches_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `users` ADD CONSTRAINT `users_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `roles` ADD CONSTRAINT `roles_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_role_id_fkey` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_permission_id_fkey` FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `user_branches` ADD CONSTRAINT `user_branches_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `user_branches` ADD CONSTRAINT `user_branches_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `user_branches` ADD CONSTRAINT `user_branches_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `user_branches` ADD CONSTRAINT `user_branches_role_id_fkey` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `products` ADD CONSTRAINT `products_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `units` ADD CONSTRAINT `units_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `units` ADD CONSTRAINT `units_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `units` ADD CONSTRAINT `units_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `units` ADD CONSTRAINT `units_supplier_id_fkey` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `units` ADD CONSTRAINT `units_purchase_id_fkey` FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `units` ADD CONSTRAINT `units_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `units` ADD CONSTRAINT `units_updated_by_fkey` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `stock_items` ADD CONSTRAINT `stock_items_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `stock_items` ADD CONSTRAINT `stock_items_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `stock_items` ADD CONSTRAINT `stock_items_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `suppliers` ADD CONSTRAINT `suppliers_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `purchases` ADD CONSTRAINT `purchases_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `purchases` ADD CONSTRAINT `purchases_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `purchases` ADD CONSTRAINT `purchases_supplier_id_fkey` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `purchases` ADD CONSTRAINT `purchases_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `purchase_items` ADD CONSTRAINT `purchase_items_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `purchase_items` ADD CONSTRAINT `purchase_items_purchase_id_fkey` FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `purchase_items` ADD CONSTRAINT `purchase_items_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `supplier_payments` ADD CONSTRAINT `supplier_payments_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `supplier_payments` ADD CONSTRAINT `supplier_payments_supplier_id_fkey` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `supplier_payments` ADD CONSTRAINT `supplier_payments_purchase_id_fkey` FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `supplier_payments` ADD CONSTRAINT `supplier_payments_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `customers` ADD CONSTRAINT `customers_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `sales` ADD CONSTRAINT `sales_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `sales` ADD CONSTRAINT `sales_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `sales` ADD CONSTRAINT `sales_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `sales` ADD CONSTRAINT `sales_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `sale_items` ADD CONSTRAINT `sale_items_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `sale_items` ADD CONSTRAINT `sale_items_sale_id_fkey` FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `sale_items` ADD CONSTRAINT `sale_items_unit_id_fkey` FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `sale_items` ADD CONSTRAINT `sale_items_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `payments` ADD CONSTRAINT `payments_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `payments` ADD CONSTRAINT `payments_sale_id_fkey` FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `returns` ADD CONSTRAINT `returns_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `returns` ADD CONSTRAINT `returns_sale_id_fkey` FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `returns` ADD CONSTRAINT `returns_sale_item_id_fkey` FOREIGN KEY (`sale_item_id`) REFERENCES `sale_items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `returns` ADD CONSTRAINT `returns_unit_id_fkey` FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `returns` ADD CONSTRAINT `returns_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_from_branch_id_fkey` FOREIGN KEY (`from_branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_to_branch_id_fkey` FOREIGN KEY (`to_branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_sent_by_fkey` FOREIGN KEY (`sent_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_received_by_fkey` FOREIGN KEY (`received_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `transfer_items` ADD CONSTRAINT `transfer_items_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `transfer_items` ADD CONSTRAINT `transfer_items_transfer_id_fkey` FOREIGN KEY (`transfer_id`) REFERENCES `stock_transfers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `transfer_items` ADD CONSTRAINT `transfer_items_unit_id_fkey` FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `transfer_items` ADD CONSTRAINT `transfer_items_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `expense_templates` ADD CONSTRAINT `expense_templates_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `expense_templates` ADD CONSTRAINT `expense_templates_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_template_id_fkey` FOREIGN KEY (`template_id`) REFERENCES `expense_templates`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `daily_closings` ADD CONSTRAINT `daily_closings_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `daily_closings` ADD CONSTRAINT `daily_closings_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `daily_closings` ADD CONSTRAINT `daily_closings_closed_by_fkey` FOREIGN KEY (`closed_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `daily_digests` ADD CONSTRAINT `daily_digests_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `daily_digests` ADD CONSTRAINT `daily_digests_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `daily_digests` ADD CONSTRAINT `daily_digests_closing_id_fkey` FOREIGN KEY (`closing_id`) REFERENCES `daily_closings`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `digest_lines` ADD CONSTRAINT `digest_lines_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `digest_lines` ADD CONSTRAINT `digest_lines_digest_id_fkey` FOREIGN KEY (`digest_id`) REFERENCES `daily_digests`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `digest_lines` ADD CONSTRAINT `digest_lines_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_target_user_id_fkey` FOREIGN KEY (`target_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `import_batches` ADD CONSTRAINT `import_batches_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `import_batches` ADD CONSTRAINT `import_batches_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `import_batches` ADD CONSTRAINT `import_batches_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `import_rows` ADD CONSTRAINT `import_rows_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `import_rows` ADD CONSTRAINT `import_rows_batch_id_fkey` FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `report_definitions` ADD CONSTRAINT `report_definitions_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `report_definitions` ADD CONSTRAINT `report_definitions_owner_user_id_fkey` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `report_snapshots` ADD CONSTRAINT `report_snapshots_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `report_snapshots` ADD CONSTRAINT `report_snapshots_definition_id_fkey` FOREIGN KEY (`definition_id`) REFERENCES `report_definitions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `settings` ADD CONSTRAINT `settings_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `settings` ADD CONSTRAINT `settings_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `sync_devices` ADD CONSTRAINT `sync_devices_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `sync_devices` ADD CONSTRAINT `sync_devices_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `outbox_changes` ADD CONSTRAINT `outbox_changes_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
