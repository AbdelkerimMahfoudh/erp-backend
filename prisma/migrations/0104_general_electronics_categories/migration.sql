-- ===========================================================================
-- 0104 — Dukan ERP as a general electronics inventory: built-in categories with stable keys, one level of
-- subcategories (the owner's decision of 2026-10-27; D223).
--
-- Why: a shop sells laptops, chargers, cases and parts as well as phones. Every company now starts with the same
-- translated taxonomy (src/catalog/default-categories.ts), identified by a stable KEY the app translates — never by a
-- name — and may still create its own categories.
--
-- product_categories gains:
--   key        — a built-in category's stable identifier; NULL for a shop's own category. UNIQUE per company.
--   parent_id  — the top-level category of a subcategory. One level only (the application refuses deeper).
--   custom_name — generated: the name when key IS NULL. The old UNIQUE (company_id, name) moves onto it, so a shop's
--                 own names stay unique among themselves while a built-in "Phones" may sit beside a shop's own
--                 "Phones". Nothing existing is renamed, merged, re-keyed or reclassified.
--
-- Existing data: NO product changes category, NO category changes its tracking mode, NO stock is relabelled. A
-- company's existing categories keep their names, modes, schemas and products, with key NULL. The built-in
-- categories are ADDED to every existing company; new companies get them when they are created (the application,
-- inside the creating transaction).
--
-- Additive for the previous release: it never reads key, parent_id or custom_name, and its own inserts (key NULL)
-- satisfy the moved uniqueness exactly as before. It never selected categories by (company_id, name) uniqueness.
--
-- Reverse (only if no category has a parent and no built-in is referenced by a product):
--   ALTER TABLE product_categories DROP FOREIGN KEY fk_product_categories_parent;
--   DELETE FROM product_categories WHERE `key` IS NOT NULL AND id NOT IN (SELECT category_id FROM products WHERE category_id IS NOT NULL);
--   ALTER TABLE product_categories DROP INDEX product_categories_company_id_custom_name_key,
--     DROP INDEX product_categories_company_id_key_key, DROP INDEX product_categories_parent_id_idx,
--     DROP COLUMN custom_name, DROP COLUMN parent_id, DROP COLUMN `key`,
--     ADD UNIQUE INDEX product_categories_company_id_name_key (company_id, name);
-- ===========================================================================

ALTER TABLE `product_categories`
  ADD COLUMN `key` VARCHAR(48) NULL AFTER `company_id`,
  ADD COLUMN `parent_id` BINARY(16) NULL AFTER `key`,
  ADD COLUMN `custom_name` VARCHAR(80)
    GENERATED ALWAYS AS (IF(`key` IS NULL, `name`, NULL)) STORED AFTER `name`;

ALTER TABLE `product_categories`
  ADD UNIQUE INDEX `product_categories_company_id_custom_name_key` (`company_id`, `custom_name`),
  DROP INDEX `product_categories_company_id_name_key`,
  ADD UNIQUE INDEX `product_categories_company_id_key_key` (`company_id`, `key`),
  ADD INDEX `product_categories_parent_id_idx` (`parent_id`),
  ADD CONSTRAINT `fk_product_categories_parent` FOREIGN KEY (`parent_id`) REFERENCES `product_categories` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Built-in categories for every existing company: top level first, then subcategories under them.

INSERT INTO `product_categories`
  (`id`, `company_id`, `key`, `parent_id`, `name`, `default_tracking_type`, `attribute_schema`, `is_active`, `created_at`, `updated_at`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), c.`id`, d.k, NULL, d.n, d.t, CAST(d.s AS JSON), 1, NOW(6), NOW(6)
FROM `companies` c
CROSS JOIN (
  SELECT 'phones' AS k, NULL AS pk, 'Phones' AS n, 'imei' AS t, '[{"key":"storage","label":"Storage","type":"measurement","unit":"GB"},{"key":"color","label":"Colour","type":"text"}]' AS s
  UNION ALL
  SELECT 'tablets' AS k, NULL AS pk, 'Tablets' AS n, 'serial' AS t, '[{"key":"storage","label":"Storage","type":"measurement","unit":"GB"},{"key":"color","label":"Colour","type":"text"},{"key":"connectivity","label":"Connectivity","type":"enum","options":["Wi-Fi","Cellular"]}]' AS s
  UNION ALL
  SELECT 'computers' AS k, NULL AS pk, 'Laptops and computers' AS n, 'serial' AS t, '[]' AS s
  UNION ALL
  SELECT 'wearables' AS k, NULL AS pk, 'Wearables' AS n, 'serial' AS t, '[{"key":"color","label":"Colour","type":"text"}]' AS s
  UNION ALL
  SELECT 'audio' AS k, NULL AS pk, 'Audio' AS n, 'quantity' AS t, '[{"key":"color","label":"Colour","type":"text"}]' AS s
  UNION ALL
  SELECT 'chargers' AS k, NULL AS pk, 'Chargers and adapters' AS n, 'quantity' AS t, '[{"key":"connector","label":"Connector","type":"enum","options":["USB-C","Lightning","Micro-USB","USB-A","HDMI","Other"]},{"key":"wattage","label":"Power","type":"measurement","unit":"W"}]' AS s
  UNION ALL
  SELECT 'cables' AS k, NULL AS pk, 'Cables' AS n, 'quantity' AS t, '[{"key":"ends","label":"Ends","type":"text"},{"key":"length","label":"Length","type":"measurement","unit":"m"},{"key":"wattage","label":"Power","type":"measurement","unit":"W"}]' AS s
  UNION ALL
  SELECT 'powerbanks' AS k, NULL AS pk, 'Power banks' AS n, 'quantity' AS t, '[{"key":"capacity","label":"Capacity","type":"measurement","unit":"mAh"},{"key":"output","label":"Output","type":"measurement","unit":"W"},{"key":"connectors","label":"Connectors","type":"text"}]' AS s
  UNION ALL
  SELECT 'cases' AS k, NULL AS pk, 'Phone cases and covers' AS n, 'quantity' AS t, '[{"key":"compatible_with","label":"Fits","type":"text"},{"key":"material","label":"Material","type":"text"},{"key":"color","label":"Colour","type":"text"}]' AS s
  UNION ALL
  SELECT 'protection' AS k, NULL AS pk, 'Screen protection' AS n, 'quantity' AS t, '[{"key":"compatible_with","label":"Fits","type":"text"},{"key":"material","label":"Type","type":"text"},{"key":"privacy","label":"Privacy","type":"enum","options":["Yes","No"]}]' AS s
  UNION ALL
  SELECT 'pcaccessories' AS k, NULL AS pk, 'Computer accessories' AS n, 'quantity' AS t, '[{"key":"color","label":"Colour","type":"text"}]' AS s
  UNION ALL
  SELECT 'storage' AS k, NULL AS pk, 'Storage' AS n, 'quantity' AS t, '[{"key":"storage","label":"Storage","type":"measurement","unit":"GB"}]' AS s
  UNION ALL
  SELECT 'networking' AS k, NULL AS pk, 'Networking' AS n, 'serial' AS t, '[{"key":"network","label":"Network","type":"enum","options":["3G","4G","5G","Wi-Fi"]}]' AS s
  UNION ALL
  SELECT 'gaming' AS k, NULL AS pk, 'Gaming' AS n, 'serial' AS t, '[]' AS s
  UNION ALL
  SELECT 'parts' AS k, NULL AS pk, 'Parts and repair stock' AS n, 'quantity' AS t, '[{"key":"compatible_with","label":"Fits","type":"text"}]' AS s
  UNION ALL
  SELECT 'other' AS k, NULL AS pk, 'Other electronics' AS n, 'quantity' AS t, '[]' AS s
) d
WHERE NOT EXISTS (SELECT 1 FROM `product_categories` x WHERE x.`company_id` = c.`id` AND x.`key` = d.k);

INSERT INTO `product_categories`
  (`id`, `company_id`, `key`, `parent_id`, `name`, `default_tracking_type`, `attribute_schema`, `is_active`, `created_at`, `updated_at`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), c.`id`, d.k, (SELECT p.`id` FROM `product_categories` p WHERE p.`company_id` = c.`id` AND p.`key` = d.pk), d.n, d.t, CAST(d.s AS JSON), 1, NOW(6), NOW(6)
FROM `companies` c
CROSS JOIN (
  SELECT 'phones.smartphones' AS k, 'phones' AS pk, 'Smartphones' AS n, 'imei' AS t, '[{"key":"storage","label":"Storage","type":"measurement","unit":"GB"},{"key":"color","label":"Colour","type":"text"}]' AS s
  UNION ALL
  SELECT 'phones.feature' AS k, 'phones' AS pk, 'Feature phones' AS n, 'imei' AS t, '[{"key":"color","label":"Colour","type":"text"}]' AS s
  UNION ALL
  SELECT 'tablets.cellular' AS k, 'tablets' AS pk, 'Cellular tablets' AS n, 'imei' AS t, '[{"key":"storage","label":"Storage","type":"measurement","unit":"GB"},{"key":"color","label":"Colour","type":"text"}]' AS s
  UNION ALL
  SELECT 'tablets.wifi' AS k, 'tablets' AS pk, 'Wi-Fi tablets' AS n, 'serial' AS t, '[{"key":"storage","label":"Storage","type":"measurement","unit":"GB"},{"key":"color","label":"Colour","type":"text"}]' AS s
  UNION ALL
  SELECT 'computers.laptops' AS k, 'computers' AS pk, 'Laptops' AS n, 'serial' AS t, '[{"key":"processor","label":"Processor","type":"text"},{"key":"ram","label":"RAM","type":"measurement","unit":"GB"},{"key":"storage","label":"Storage","type":"measurement","unit":"GB"},{"key":"color","label":"Colour","type":"text"}]' AS s
  UNION ALL
  SELECT 'computers.desktops' AS k, 'computers' AS pk, 'Desktop computers' AS n, 'serial' AS t, '[{"key":"processor","label":"Processor","type":"text"},{"key":"ram","label":"RAM","type":"measurement","unit":"GB"},{"key":"storage","label":"Storage","type":"measurement","unit":"GB"}]' AS s
  UNION ALL
  SELECT 'computers.monitors' AS k, 'computers' AS pk, 'Monitors' AS n, 'serial' AS t, '[{"key":"screen_size","label":"Screen size","type":"measurement","unit":"in"}]' AS s
  UNION ALL
  SELECT 'wearables.smartwatches' AS k, 'wearables' AS pk, 'Smartwatches' AS n, 'serial' AS t, '[{"key":"color","label":"Colour","type":"text"},{"key":"size","label":"Size","type":"measurement","unit":"mm"}]' AS s
  UNION ALL
  SELECT 'wearables.bands' AS k, 'wearables' AS pk, 'Fitness bands' AS n, 'quantity' AS t, '[{"key":"color","label":"Colour","type":"text"}]' AS s
  UNION ALL
  SELECT 'audio.earbuds' AS k, 'audio' AS pk, 'Earbuds' AS n, 'quantity' AS t, '[{"key":"color","label":"Colour","type":"text"}]' AS s
  UNION ALL
  SELECT 'audio.headphones' AS k, 'audio' AS pk, 'Headphones' AS n, 'quantity' AS t, '[{"key":"wireless","label":"Connection","type":"enum","options":["Wired","Wireless"]},{"key":"color","label":"Colour","type":"text"}]' AS s
  UNION ALL
  SELECT 'audio.headsets' AS k, 'audio' AS pk, 'Headsets' AS n, 'quantity' AS t, '[{"key":"wireless","label":"Connection","type":"enum","options":["Wired","Wireless"]},{"key":"color","label":"Colour","type":"text"}]' AS s
  UNION ALL
  SELECT 'audio.speakers' AS k, 'audio' AS pk, 'Speakers' AS n, 'quantity' AS t, '[{"key":"color","label":"Colour","type":"text"}]' AS s
  UNION ALL
  SELECT 'chargers.wall' AS k, 'chargers' AS pk, 'Wall chargers' AS n, 'quantity' AS t, '[{"key":"connector","label":"Connector","type":"enum","options":["USB-C","Lightning","Micro-USB","USB-A","HDMI","Other"]},{"key":"wattage","label":"Power","type":"measurement","unit":"W"}]' AS s
  UNION ALL
  SELECT 'chargers.car' AS k, 'chargers' AS pk, 'Car chargers' AS n, 'quantity' AS t, '[{"key":"connector","label":"Connector","type":"enum","options":["USB-C","Lightning","Micro-USB","USB-A","HDMI","Other"]},{"key":"wattage","label":"Power","type":"measurement","unit":"W"}]' AS s
  UNION ALL
  SELECT 'chargers.wireless' AS k, 'chargers' AS pk, 'Wireless chargers' AS n, 'quantity' AS t, '[{"key":"wattage","label":"Power","type":"measurement","unit":"W"}]' AS s
  UNION ALL
  SELECT 'chargers.adapters' AS k, 'chargers' AS pk, 'Power adapters' AS n, 'quantity' AS t, '[{"key":"connector","label":"Connector","type":"enum","options":["USB-C","Lightning","Micro-USB","USB-A","HDMI","Other"]},{"key":"wattage","label":"Power","type":"measurement","unit":"W"}]' AS s
  UNION ALL
  SELECT 'cables.usbc' AS k, 'cables' AS pk, 'USB-C' AS n, 'quantity' AS t, '[{"key":"length","label":"Length","type":"measurement","unit":"m"},{"key":"wattage","label":"Power","type":"measurement","unit":"W"}]' AS s
  UNION ALL
  SELECT 'cables.lightning' AS k, 'cables' AS pk, 'Lightning' AS n, 'quantity' AS t, '[{"key":"length","label":"Length","type":"measurement","unit":"m"}]' AS s
  UNION ALL
  SELECT 'cables.microusb' AS k, 'cables' AS pk, 'Micro-USB' AS n, 'quantity' AS t, '[{"key":"length","label":"Length","type":"measurement","unit":"m"}]' AS s
  UNION ALL
  SELECT 'cables.hdmi' AS k, 'cables' AS pk, 'HDMI' AS n, 'quantity' AS t, '[{"key":"length","label":"Length","type":"measurement","unit":"m"}]' AS s
  UNION ALL
  SELECT 'cables.other' AS k, 'cables' AS pk, 'Other cables' AS n, 'quantity' AS t, '[{"key":"ends","label":"Ends","type":"text"},{"key":"length","label":"Length","type":"measurement","unit":"m"}]' AS s
  UNION ALL
  SELECT 'protection.glass' AS k, 'protection' AS pk, 'Tempered glass' AS n, 'quantity' AS t, '[{"key":"compatible_with","label":"Fits","type":"text"},{"key":"privacy","label":"Privacy","type":"enum","options":["Yes","No"]}]' AS s
  UNION ALL
  SELECT 'protection.films' AS k, 'protection' AS pk, 'Films' AS n, 'quantity' AS t, '[{"key":"compatible_with","label":"Fits","type":"text"}]' AS s
  UNION ALL
  SELECT 'protection.privacy' AS k, 'protection' AS pk, 'Privacy protectors' AS n, 'quantity' AS t, '[{"key":"compatible_with","label":"Fits","type":"text"}]' AS s
  UNION ALL
  SELECT 'protection.camera' AS k, 'protection' AS pk, 'Camera protectors' AS n, 'quantity' AS t, '[{"key":"compatible_with","label":"Fits","type":"text"}]' AS s
  UNION ALL
  SELECT 'pcaccessories.mice' AS k, 'pcaccessories' AS pk, 'Mice' AS n, 'quantity' AS t, '[{"key":"wireless","label":"Connection","type":"enum","options":["Wired","Wireless"]}]' AS s
  UNION ALL
  SELECT 'pcaccessories.keyboards' AS k, 'pcaccessories' AS pk, 'Keyboards' AS n, 'quantity' AS t, '[{"key":"wireless","label":"Connection","type":"enum","options":["Wired","Wireless"]},{"key":"layout","label":"Layout","type":"text"}]' AS s
  UNION ALL
  SELECT 'pcaccessories.stands' AS k, 'pcaccessories' AS pk, 'Laptop stands' AS n, 'quantity' AS t, '[]' AS s
  UNION ALL
  SELECT 'pcaccessories.webcams' AS k, 'pcaccessories' AS pk, 'Webcams' AS n, 'quantity' AS t, '[]' AS s
  UNION ALL
  SELECT 'storage.memorycards' AS k, 'storage' AS pk, 'Memory cards' AS n, 'quantity' AS t, '[{"key":"storage","label":"Storage","type":"measurement","unit":"GB"},{"key":"class","label":"Speed class","type":"text"}]' AS s
  UNION ALL
  SELECT 'storage.usb' AS k, 'storage' AS pk, 'USB drives' AS n, 'quantity' AS t, '[{"key":"storage","label":"Storage","type":"measurement","unit":"GB"}]' AS s
  UNION ALL
  SELECT 'storage.ssd' AS k, 'storage' AS pk, 'SSDs' AS n, 'quantity' AS t, '[{"key":"storage","label":"Storage","type":"measurement","unit":"GB"}]' AS s
  UNION ALL
  SELECT 'storage.hdd' AS k, 'storage' AS pk, 'Hard drives' AS n, 'quantity' AS t, '[{"key":"storage","label":"Storage","type":"measurement","unit":"GB"}]' AS s
  UNION ALL
  SELECT 'networking.routers' AS k, 'networking' AS pk, 'Routers' AS n, 'serial' AS t, '[{"key":"network","label":"Network","type":"enum","options":["3G","4G","5G","Wi-Fi"]}]' AS s
  UNION ALL
  SELECT 'networking.mifi' AS k, 'networking' AS pk, 'MiFi devices' AS n, 'imei' AS t, '[{"key":"network","label":"Network","type":"enum","options":["3G","4G","5G"]}]' AS s
  UNION ALL
  SELECT 'networking.repeaters' AS k, 'networking' AS pk, 'Repeaters' AS n, 'quantity' AS t, '[]' AS s
  UNION ALL
  SELECT 'networking.accessories' AS k, 'networking' AS pk, 'Network accessories' AS n, 'quantity' AS t, '[]' AS s
  UNION ALL
  SELECT 'gaming.consoles' AS k, 'gaming' AS pk, 'Consoles' AS n, 'serial' AS t, '[{"key":"storage","label":"Storage","type":"measurement","unit":"GB"},{"key":"color","label":"Colour","type":"text"}]' AS s
  UNION ALL
  SELECT 'gaming.controllers' AS k, 'gaming' AS pk, 'Controllers' AS n, 'quantity' AS t, '[{"key":"color","label":"Colour","type":"text"}]' AS s
  UNION ALL
  SELECT 'gaming.accessories' AS k, 'gaming' AS pk, 'Gaming accessories' AS n, 'quantity' AS t, '[]' AS s
  UNION ALL
  SELECT 'parts.screens' AS k, 'parts' AS pk, 'Screens' AS n, 'quantity' AS t, '[{"key":"compatible_with","label":"Fits","type":"text"}]' AS s
  UNION ALL
  SELECT 'parts.batteries' AS k, 'parts' AS pk, 'Batteries' AS n, 'quantity' AS t, '[{"key":"compatible_with","label":"Fits","type":"text"},{"key":"capacity","label":"Capacity","type":"measurement","unit":"mAh"}]' AS s
  UNION ALL
  SELECT 'parts.ports' AS k, 'parts' AS pk, 'Charging ports' AS n, 'quantity' AS t, '[{"key":"compatible_with","label":"Fits","type":"text"}]' AS s
  UNION ALL
  SELECT 'parts.cameras' AS k, 'parts' AS pk, 'Camera modules' AS n, 'quantity' AS t, '[{"key":"compatible_with","label":"Fits","type":"text"}]' AS s
) d
WHERE NOT EXISTS (SELECT 1 FROM `product_categories` x WHERE x.`company_id` = c.`id` AND x.`key` = d.k);
