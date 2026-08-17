-- 0047 — goals: a target somebody is actually working toward
--
-- ## What the F0 audit found
--
-- Nothing. There is no goal or target model anywhere in the schema, no service,
-- and no screen. This is entirely new.
--
-- What already exists and must NOT be duplicated:
--
--   `daily_rollups` already carries `revenue`, `gross_profit`, `sales_count`
--   and `qty_sold` per branch-day, and it already accounts for returns. A goal
--   asks a different question — progress toward a target over a period — but it
--   asks it of the SAME figures. Recomputing them here would create a second
--   definition of gross profit, which is exactly the drift Milestone E spent a
--   whole checkpoint pinning shut.
--
--   `sales.user_id` is immutable, so per-person attribution needs no new
--   column. A sale belongs to whoever made it, permanently.
--
-- ## What is deliberately NOT stored
--
-- **Progress.** It is derived from the rollup every time a goal is read, and
-- stored nowhere — the same rule the employee debt balance follows in `0045`.
-- A stored progress figure can disagree with the sales it claims to summarise,
-- and it would need invalidating on every sale, return, refund and correction.
--
-- Rerun-safe: guarded.

CREATE TABLE IF NOT EXISTS `goals` (
  `id`         BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,

  /*
   * Who the goal belongs to.
   *   `company` — every branch together. `branch_id` and `target_user_id` NULL.
   *   `branch`  — one branch. `branch_id` set.
   *   `user`    — one person, within one branch. Both set.
   *
   * A person's goal is branch-scoped on purpose: somebody working across two
   * shops has two jobs, and one merged number would hide which is going badly.
   */
  `scope` ENUM('company','branch','user') NOT NULL,
  `branch_id`      BINARY(16) NULL,
  `target_user_id` BINARY(16) NULL,

  /*
   * What is being measured. Each one maps to a figure the rollup already
   * computes, so a goal can never disagree with the day's analytics:
   *
   *   `gross_profit` → daily_rollups.gross_profit   (returns already deducted)
   *   `revenue`      → daily_rollups.revenue
   *   `sales_count`  → daily_rollups.sales_count
   *   `units_sold`   → daily_rollups.qty_sold
   *
   * Deliberately NOT `net_profit`: expenses are not the salesperson's doing,
   * and a target somebody cannot influence is not a goal, it is a grievance.
   */
  `metric` ENUM('gross_profit','revenue','sales_count','units_sold') NOT NULL,

  /*
   * A goal covers a real, closed range of days. Storing the two dates rather
   * than a period type plus an offset means a month that started mid-month, or
   * a one-off push over a holiday week, is expressible without a special case.
   */
  `period_start` DATE NOT NULL,
  `period_end`   DATE NOT NULL,
  /* Kept for wording only ("this month"), never for arithmetic. */
  `period_label` ENUM('daily','weekly','monthly','custom') NOT NULL DEFAULT 'custom',

  `target_amount` DECIMAL(14,2) NOT NULL,

  /*
   * Archived rather than deleted. A goal that was missed is a fact about the
   * shop's history, and deleting it would make every past period look met.
   */
  `status` ENUM('active','archived') NOT NULL DEFAULT 'active',
  `archived_reason` VARCHAR(255) NULL,

  `note` VARCHAR(255) NULL,

  `created_by_id` BINARY(16) NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `version` INT NOT NULL DEFAULT 0,

  /*
   * MySQL has no partial unique index, so the active-row key is generated —
   * the `active_unit_id` precedent from 0002. Two ACTIVE goals for the same
   * person, metric and period would make "am I on target" have two answers;
   * archived ones are free to pile up, which is the point of archiving.
   */
  `active_key` VARCHAR(120) AS (
    IF(`status` = 'active',
       CONCAT(`scope`, ':', IFNULL(HEX(`branch_id`), '-'), ':',
              IFNULL(HEX(`target_user_id`), '-'), ':', `metric`, ':',
              `period_start`, ':', `period_end`),
       NULL)
  ) VIRTUAL,

  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_goals_active` (`company_id`, `active_key`),
  KEY `ix_goals_lookup` (`company_id`, `branch_id`, `status`, `period_end`),
  KEY `ix_goals_user` (`company_id`, `target_user_id`, `status`),
  KEY `ix_goals_created_by` (`created_by_id`),
  CONSTRAINT `fk_goals_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_goals_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_goals_user` FOREIGN KEY (`target_user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_goals_created_by` FOREIGN KEY (`created_by_id`) REFERENCES `users` (`id`),

  -- The scope and its two columns agree, in both directions, so a half-scoped
  -- goal cannot exist.
  CONSTRAINT `ck_goals_scope` CHECK (
    (`scope` = 'company' AND `branch_id` IS NULL AND `target_user_id` IS NULL)
    OR (`scope` = 'branch' AND `branch_id` IS NOT NULL AND `target_user_id` IS NULL)
    OR (`scope` = 'user' AND `branch_id` IS NOT NULL AND `target_user_id` IS NOT NULL)
  ),
  -- A target of zero or less is met before anybody starts.
  CONSTRAINT `ck_goals_target` CHECK (`target_amount` > 0),
  -- A period runs forwards.
  CONSTRAINT `ck_goals_period` CHECK (`period_end` >= `period_start`),
  -- Archiving states why, like every other decision in this schema.
  CONSTRAINT `ck_goals_archived` CHECK (
    `status` = 'active' OR TRIM(COALESCE(`archived_reason`, '')) <> ''
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A goal that has been worked toward is not deleted. Missing a target is a fact
-- about the shop, and removing it would make every past period look met.
DROP TRIGGER IF EXISTS `goals_block_delete`;
CREATE TRIGGER `goals_block_delete`
BEFORE DELETE ON `goals`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'A goal is archived with a reason, never deleted';
  END IF;
END;

-- Permissions ------------------------------------------------------------------
-- Setting a target is deciding what the shop is aiming at, so `goal.manage` is
-- Owner and Manager. Seeing one is NOT gated on `report.view`: an employee with
-- a personal target must be able to see it, and `report.view` would hand them
-- the shop's profit reporting at the same time — which is precisely the split
-- `cost.view` and `report.view` already keep apart.
INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'goal.manage', 'Set and archive goals'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'goal.manage');

INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` = 'goal.manage'
WHERE r.`key` IN ('owner', 'store_manager')
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- Reverse SQL (not executed):
--   DROP TRIGGER IF EXISTS `goals_block_delete`;
--   DROP TABLE IF EXISTS `goals`;
--   DELETE rp FROM `role_permissions` rp JOIN `permissions` p ON p.`id` = rp.`permission_id`
--     WHERE p.`key` = 'goal.manage';
--   DELETE FROM `permissions` WHERE `key` = 'goal.manage';
