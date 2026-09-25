import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **Goals read the figures the analytics already own** (Milestone F).
 *
 * Milestone E spent a whole checkpoint pinning the reconciliation equation
 * shut, because five milestones had each added a term to expected cash and
 * nobody was looking at the whole thing. Goals are the next obvious place for
 * the same mistake: "gross profit this month" is a figure the rollup already
 * computes, and a goal that recomputes it from scratch would quietly disagree
 * with the dashboard next to it.
 *
 * These assert that goals never grow their own definition of a metric.
 */

const SRC = __dirname;
const service = readFileSync(join(SRC, 'goals.service.ts'), 'utf8');
const progress = readFileSync(join(SRC, 'goal-progress.ts'), 'utf8');
const schema = readFileSync(join(SRC, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
const migrationSql = readFileSync(
  join(SRC, '..', '..', 'prisma', 'migrations', '0047_goals', 'migration.sql'),
  'utf8',
);

describe('branch and company progress comes from the rollup', () => {
  it('reads daily_rollups, not sales', () => {
    const branchPath = service.slice(
      service.indexOf("if (goal.scope !== 'user')"),
      service.indexOf('Per person'),
    );
    expect(branchPath).toContain('FROM daily_rollups');
    expect(branchPath).not.toContain('FROM sale_items');
  });

  it('sums a column the rollup writes, never an expression of its own', () => {
    /**
     * The whole point. If this ever becomes `SUM(price * quantity - discount)`,
     * a goal and the day's analytics can disagree about the same period while
     * both look right on their own screen.
     */
    const branchPath = service.slice(
      service.indexOf("if (goal.scope !== 'user')"),
      service.indexOf('Per person'),
    );
    // Cancellations and returns come off through the rollup's own columns (0079, 0080, docs/53): still no expression of its own.
    expect(branchPath).toContain('SUM(${Prisma.raw(`\\`${METRIC_COLUMN[metric]}\\` - (${ADJUSTMENT[metric]})`)})');
    expect(branchPath).not.toContain('FROM sale_items');
  });

  it('the adjustment reads only columns the rollup model has — cancellations and returns (0079, 0080, docs/53)', () => {
    const adjustment = progress.slice(progress.indexOf('export const ADJUSTMENT'), progress.indexOf('export const METRIC_COLUMN'));
    const columns = [...adjustment.matchAll(/`(\w+)`/g)].map((m) => m[1]).filter((c) => c.startsWith('cancelled_') || c.startsWith('returns_'));
    expect(new Set(columns)).toEqual(
      new Set(['cancelled_revenue', 'cancelled_cogs', 'cancelled_count', 'cancelled_qty', 'returns_revenue', 'returns_adjustments', 'returns_gross_profit', 'returns_count']),
    );
    const model = schema.slice(schema.indexOf('model DailyRollup'));
    const body = model.slice(0, model.indexOf('\n}'));
    for (const column of columns) expect(body).toContain(`@map("${column}")`);
  });

  it('every metric maps to a column the rollup model actually has', () => {
    /**
     * Checked against the schema, not against `rollup.service.ts` — the service
     * writes through Prisma's camelCase fields, so the snake_case column names
     * only exist in the model's `@map`. Asserting on the service would have
     * been asserting on the wrong artifact and passing for the wrong reason.
     */
    const model = schema.slice(schema.indexOf('model DailyRollup'));
    const body = model.slice(0, model.indexOf('\n}'));
    for (const column of ['gross_profit', 'revenue', 'sales_count', 'qty_sold']) {
      // Either mapped explicitly, or named identically in both.
      expect(body).toMatch(new RegExp(`@map\\("${column}"\\)|^\\s*${column}\\s`, 'm'));
    }
  });
});

describe('a personal goal is attributed to whoever made the sale', () => {
  it('filters on sales.user_id, which is immutable', () => {
    /**
     * There is no per-user rollup, so a personal figure has to come from the
     * sale lines. `sales.user_id` never changes, so a sale belongs to whoever
     * made it permanently — reassigning credit after the fact is not possible,
     * which is what makes a personal target trustworthy.
     */
    expect(service).toMatch(/AND s\.user_id = \$\{goal\.targetUserId\}/);
  });

  it('excludes voided lines, the same as every other money query here', () => {
    expect(service).toMatch(/AND si\.voided = 0/);
  });

  it('counts SALES per person on the sale, not per line', () => {
    /**
     * Three phones on one receipt is one sale. That is what "how many sales did
     * you make" means to the person being measured, and summing lines would
     * flatter whoever sells in bundles.
     */
    expect(service).toContain("sales_count: 'COUNT(*)'");
    // Read over the sales themselves, never joined to their lines — so a sale is counted once.
    expect(service).toMatch(/\(SELECT \$\{value\}\s+FROM sales s\s+WHERE \$\{person\}/);
    expect(service).toMatch(/\(SELECT \$\{value\}\s+FROM financial_corrections fc\s+JOIN sales s ON s\.id = fc\.target_sale_id\s+WHERE/);
  });
});

describe('what a goal is allowed to measure', () => {
  it('has no net_profit metric anywhere in the stack', () => {
    /**
     * Expenses are not the salesperson's doing. A target somebody cannot
     * influence is not a goal, it is a grievance — and the enum, the DTO and
     * the mapping all have to agree about that, not just one of them.
     */
    const metrics = ['gross_profit', 'revenue', 'sales_count', 'units_sold'];

    // The mapping the service reads.
    const mapping = progress.slice(progress.indexOf('export const METRIC_COLUMN'));
    expect([...mapping.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1])).toEqual(metrics);

    // The validator the API accepts. Asserted on the `@IsIn` list rather than
    // on the file's text — the doc comment above it says the words
    // "No net_profit", and a raw substring check would trip on the very comment
    // that explains the absence.
    const dto = readFileSync(join(SRC, 'dto', 'create-goal.dto.ts'), 'utf8');
    const isIn = dto.slice(dto.indexOf("@IsIn(['gross_profit'"));
    expect([...isIn.slice(0, isIn.indexOf('])')).matchAll(/'(\w+)'/g)].map((m) => m[1])).toEqual(metrics);

    // And the database, which is the only one that cannot be worked around.
    expect(migrationSql).toContain(
      "`metric` ENUM('gross_profit','revenue','sales_count','units_sold') NOT NULL",
    );
  });
});

describe('progress is derived, never stored', () => {
  it('the service computes it on every read', () => {
    expect(service).toMatch(/progress: computeProgress\(\{/);
  });

  it('nothing writes a progress or achieved column', () => {
    /**
     * A stored progress figure can disagree with the sales it claims to
     * summarise, and it would need invalidating on every sale, return, refund
     * and correction. The employee debt balance follows the same rule for the
     * same reason.
     */
    expect(migrationSql).not.toMatch(/`(progress|achieved|current_amount)`/);
  });
});
