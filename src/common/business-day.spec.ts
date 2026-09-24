import {
  businessDateOf,
  datesBetween,
  dayWindow,
  isBeforeDayStart,
  isDateString,
  isValidTimezone,
  localDateOf,
  localInstant,
  offsetMinutes,
  periodRange,
  shiftDate,
  localTimeOf,
} from './business-day';

/**
 * The 06:00 rule, pinned at its edges (docs/50 §3.1).
 *
 * Nouakchott is UTC+0 all year, so on the live companies only the cutoff
 * moves anything; the positive- and negative-offset zones prove the rule is
 * about the LOCAL clock and not about UTC.
 */
describe('businessDateOf', () => {
  it('05:59:59 local is still the previous business date; 06:00:00 starts the new one', () => {
    expect(businessDateOf(new Date('2026-09-23T05:59:59.999Z'), 'Africa/Nouakchott')).toBe('2026-09-22');
    expect(businessDateOf(new Date('2026-09-23T06:00:00.000Z'), 'Africa/Nouakchott')).toBe('2026-09-23');
    expect(businessDateOf(new Date('2026-09-23T05:59:59.999Z'), 'UTC')).toBe('2026-09-22');
    expect(businessDateOf(new Date('2026-09-23T06:00:00.000Z'), 'UTC')).toBe('2026-09-23');
  });

  it('reads the local clock, not UTC', () => {
    // 02:30 UTC is 06:30 in Dubai (UTC+4, no daylight saving): the new day has begun.
    expect(businessDateOf(new Date('2026-09-23T02:30:00.000Z'), 'Asia/Dubai')).toBe('2026-09-23');
    // 01:30 UTC is 05:30 in Dubai: still yesterday.
    expect(businessDateOf(new Date('2026-09-23T01:30:00.000Z'), 'Asia/Dubai')).toBe('2026-09-22');
    // 10:00 UTC is 05:00 in New York (UTC−5 in September... EDT is UTC−4: 06:00).
    expect(businessDateOf(new Date('2026-09-23T10:00:00.000Z'), 'America/New_York')).toBe('2026-09-23');
    expect(businessDateOf(new Date('2026-09-23T09:59:00.000Z'), 'America/New_York')).toBe('2026-09-22');
  });

  it('crosses a month and a year boundary the calendar way', () => {
    expect(businessDateOf(new Date('2026-10-01T02:00:00.000Z'), 'UTC')).toBe('2026-09-30');
    expect(businessDateOf(new Date('2027-01-01T05:00:00.000Z'), 'UTC')).toBe('2026-12-31');
    expect(businessDateOf(new Date('2027-01-01T06:00:00.000Z'), 'UTC')).toBe('2027-01-01');
    expect(businessDateOf(new Date('2028-03-01T01:00:00.000Z'), 'UTC')).toBe('2028-02-29');
  });

  it('refuses an unknown timezone instead of reading it as UTC', () => {
    expect(() => businessDateOf(new Date(), 'Mars/Olympus')).toThrow(/Unknown timezone/);
    expect(isValidTimezone('Africa/Nouakchott')).toBe(true);
    expect(isValidTimezone('Nowhere/Zone')).toBe(false);
  });
});

describe('dayWindow', () => {
  it('spans 06:00 local to 06:00 local of the next calendar date', () => {
    const w = dayWindow('2026-09-23', 'Africa/Nouakchott');
    expect(w.start.toISOString()).toBe('2026-09-23T06:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-09-24T06:00:00.000Z');
    const dubai = dayWindow('2026-09-23', 'Asia/Dubai');
    expect(dubai.start.toISOString()).toBe('2026-09-23T02:00:00.000Z');
    expect(dubai.end.toISOString()).toBe('2026-09-24T02:00:00.000Z');
  });

  it('every instant in the window maps back to the same business date, and the edges do not', () => {
    for (const tz of ['UTC', 'Africa/Cairo', 'America/New_York', 'Asia/Kolkata', 'Asia/Dubai']) {
      const w = dayWindow('2026-09-23', tz);
      expect(businessDateOf(w.start, tz)).toBe('2026-09-23');
      expect(businessDateOf(new Date(w.end.getTime() - 1), tz)).toBe('2026-09-23');
      expect(businessDateOf(w.end, tz)).toBe('2026-09-24');
      expect(businessDateOf(new Date(w.start.getTime() - 1), tz)).toBe('2026-09-22');
    }
  });

  it('localInstant and offsetMinutes agree with the zone', () => {
    expect(offsetMinutes(new Date('2026-09-23T12:00:00.000Z'), 'Asia/Kolkata')).toBe(330);
    expect(offsetMinutes(new Date('2026-09-23T12:00:00.000Z'), 'UTC')).toBe(0);
    expect(localInstant('2026-09-23', 6, 'Asia/Kolkata').toISOString()).toBe('2026-09-23T00:30:00.000Z');
  });
});

describe('dates and periods', () => {
  it('shifts across months and leap years', () => {
    expect(shiftDate('2026-09-30', 1)).toBe('2026-10-01');
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDate('2028-03-01', -1)).toBe('2028-02-29');
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('validates a date string strictly', () => {
    expect(isDateString('2026-09-23')).toBe(true);
    expect(isDateString('2026-02-30')).toBe(false);
    expect(isDateString('23/09/2026')).toBe(false);
    expect(isDateString(20260923)).toBe(false);
  });

  it('Today, 7 days and This month are exact business-date ranges ending today', () => {
    expect(periodRange('today', '2026-09-23')).toEqual({ from: '2026-09-23', to: '2026-09-23' });
    expect(periodRange('week', '2026-09-23')).toEqual({ from: '2026-09-17', to: '2026-09-23' });
    expect(periodRange('week', '2026-10-03')).toEqual({ from: '2026-09-27', to: '2026-10-03' });
    expect(periodRange('month', '2026-09-23')).toEqual({ from: '2026-09-01', to: '2026-09-23' });
    expect(periodRange('month', '2026-09-01')).toEqual({ from: '2026-09-01', to: '2026-09-01' });
    expect(datesBetween('2026-09-29', '2026-10-02')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  });

  it('the early-start choice exists only after local midnight and before 06:00', () => {
    const tz = 'Africa/Nouakchott';
    expect(isBeforeDayStart(new Date('2026-09-24T03:00:00.000Z'), tz, '2026-09-23')).toBe(true);
    expect(isBeforeDayStart(new Date('2026-09-23T23:30:00.000Z'), tz, '2026-09-23')).toBe(false);
    expect(isBeforeDayStart(new Date('2026-09-24T06:00:00.000Z'), tz, '2026-09-23')).toBe(false);
    expect(localDateOf(new Date('2026-09-24T03:00:00.000Z'), tz)).toBe('2026-09-24');
  });
});

describe('localTimeOf', () => {
  it('reads the wall clock of the zone, zero-padded, on a 24-hour dial', () => {
    expect(localTimeOf(new Date('2026-09-24T07:25:00Z'), 'UTC')).toBe('07:25');
    expect(localTimeOf(new Date('2026-09-24T03:05:00Z'), 'Asia/Dubai')).toBe('07:05');
    expect(localTimeOf(new Date('2026-09-24T23:59:30Z'), 'UTC')).toBe('23:59');
  });
});
