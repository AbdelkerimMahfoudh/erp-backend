import { computeProgress, isMoneyMetric, METRIC_COLUMN } from './goal-progress';

/**
 * "Am I on target" is the whole product value of a goal, so these pin the
 * answer — especially the cases where a naive percentage would say something
 * true and useless, or true and wrong.
 */

const march = { periodStart: '2026-03-01', periodEnd: '2026-03-31' };

describe('a period that has not started', () => {
  it('says so, rather than saying 0% behind', () => {
    const p = computeProgress({ ...march, target: 3100, achieved: 0, today: '2026-02-25' });
    expect(p.state).toBe('not_started');
    expect(p.daysElapsed).toBe(0);
    expect(p.daysRemaining).toBe(31);
  });

  it('offers no pace, because pace against zero elapsed days is not a number', () => {
    const p = computeProgress({ ...march, target: 3100, achieved: 0, today: '2026-02-25' });
    expect(p.expectedByNow).toBeNull();
  });
});

describe('a period that is running', () => {
  it('counts today as elapsed — somebody looking at midday is part-way through it', () => {
    const p = computeProgress({ ...march, target: 3100, achieved: 0, today: '2026-03-01' });
    expect(p.daysElapsed).toBe(1);
    expect(p.daysRemaining).toBe(30);
  });

  it('is on track when it matches the days elapsed', () => {
    // 10 days of a 31-day month at 100/day.
    const p = computeProgress({ ...march, target: 3100, achieved: 1000, today: '2026-03-10' });
    expect(p.expectedByNow).toBe(1000);
    expect(p.state).toBe('on_track');
  });

  it('is behind when it does not', () => {
    const p = computeProgress({ ...march, target: 3100, achieved: 400, today: '2026-03-10' });
    expect(p.state).toBe('behind');
  });

  it('says what is needed per remaining day to still make it', () => {
    // 2700 short with 21 days left.
    const p = computeProgress({ ...march, target: 3100, achieved: 400, today: '2026-03-10' });
    expect(p.remaining).toBe(2700);
    expect(p.daysRemaining).toBe(21);
    expect(p.neededPerRemainingDay).toBe(128.57);
  });
});

describe('a target that has been reached', () => {
  it('reads as met, not as ahead of pace', () => {
    /**
     * Checked before pace on purpose. Somebody who hit their month's target on
     * the 8th should be told they made it — not that they are running ahead.
     */
    const p = computeProgress({ ...march, target: 3100, achieved: 3200, today: '2026-03-08' });
    expect(p.state).toBe('met');
  });

  it('reports the percentage uncapped, because 103% is worth knowing', () => {
    const p = computeProgress({ ...march, target: 3100, achieved: 3200, today: '2026-03-08' });
    expect(p.percent).toBe(103.23);
  });

  it('has nothing remaining and nothing needed per day', () => {
    const p = computeProgress({ ...march, target: 3100, achieved: 3200, today: '2026-03-08' });
    expect(p.remaining).toBe(0);
    expect(p.neededPerRemainingDay).toBeNull();
  });

  it('stays met after the period ends', () => {
    const p = computeProgress({ ...march, target: 3100, achieved: 3100, today: '2026-04-02' });
    expect(p.state).toBe('met');
  });
});

describe('a period that has ended short', () => {
  const ended = { ...march, target: 3100, achieved: 2000, today: '2026-04-01' };

  it('is MISSED, not behind', () => {
    /**
     * A different word, deliberately. Nothing can be done about a closed
     * period, and telling somebody they are "behind" on a month that has ended
     * asks them to catch up on days that no longer exist.
     */
    expect(computeProgress(ended).state).toBe('missed');
  });

  it('asks for nothing per remaining day, because there are none', () => {
    const p = computeProgress(ended);
    expect(p.daysRemaining).toBe(0);
    expect(p.neededPerRemainingDay).toBeNull();
  });

  it('still reports how close it got', () => {
    expect(computeProgress(ended).percent).toBe(64.52);
  });
});

describe('a single-day goal', () => {
  const today = { periodStart: '2026-03-05', periodEnd: '2026-03-05', today: '2026-03-05' };

  it('counts as one day, not zero', () => {
    expect(computeProgress({ ...today, target: 500, achieved: 0 }).daysTotal).toBe(1);
  });

  it('expects the whole target by the end of it', () => {
    expect(computeProgress({ ...today, target: 500, achieved: 0 }).expectedByNow).toBe(500);
  });

  it('is behind, not missed, while the day is still running', () => {
    expect(computeProgress({ ...today, target: 500, achieved: 100 }).state).toBe('behind');
  });
});

describe('the metric mapping', () => {
  it('reads only columns the rollup already computes', () => {
    /**
     * The single mapping, in one place. `daily_rollups` already accounts for
     * returns, so a goal and the day's analytics cannot disagree about the same
     * period — the drift Milestone E pinned shut for the reconciliation
     * equation, kept shut here.
     */
    expect(METRIC_COLUMN).toEqual({
      gross_profit: 'gross_profit',
      revenue: 'revenue',
      sales_count: 'sales_count',
      units_sold: 'qty_sold',
    });
  });

  it('has no net_profit metric', () => {
    /**
     * Expenses are not the salesperson's doing. A target somebody cannot
     * influence is not a goal, it is a grievance.
     */
    expect(Object.keys(METRIC_COLUMN)).not.toContain('net_profit');
  });

  it('knows which metrics are money, so a screen can format them', () => {
    expect(isMoneyMetric('gross_profit')).toBe(true);
    expect(isMoneyMetric('revenue')).toBe(true);
    expect(isMoneyMetric('sales_count')).toBe(false);
    expect(isMoneyMetric('units_sold')).toBe(false);
  });
});
