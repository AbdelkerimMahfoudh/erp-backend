import { barsSumTo, dailyBars, groupedBars, hourlyBars } from './home-series';

describe('Home series', () => {
  it('today: 24 hourly bars from 06:00, hours after midnight on the next calendar date, summing to the sales value', () => {
    const tz = 'Africa/Nouakchott';
    const sales = [
      { soldAt: new Date('2026-09-23T06:15:00Z'), total: 1000 },
      { soldAt: new Date('2026-09-23T14:20:00Z'), total: 2500.5 },
      { soldAt: new Date('2026-09-23T23:59:00Z'), total: 300 },
      { soldAt: new Date('2026-09-24T02:30:00Z'), total: 199.5 },
    ];
    const bars = hourlyBars(sales, tz, '2026-09-23');
    expect(bars).toHaveLength(24);
    expect(bars[0]).toMatchObject({ label: '06', from: '2026-09-23T06:00', value: 1000 });
    expect(bars.find((b) => b.label === '14')?.value).toBe(2500.5);
    expect(bars.find((b) => b.label === '23')?.value).toBe(300);
    expect(bars.find((b) => b.label === '02')).toMatchObject({ from: '2026-09-24T02:00', value: 199.5 });
    expect(bars[23].label).toBe('05');
    expect(barsSumTo(bars, 4000)).toBe(true);
  });

  it('hours are the LOCAL clock', () => {
    const bars = hourlyBars([{ soldAt: new Date('2026-09-23T02:30:00Z'), total: 5 }], 'Asia/Dubai', '2026-09-23');
    expect(bars.find((b) => b.label === '06')?.value).toBe(5);
  });

  it('7 days: one bar per business date in order, zero where nothing sold', () => {
    const bars = dailyBars(
      [
        { date: '2026-09-20', value: 900 },
        { date: '2026-09-23', value: 2100 },
      ],
      { from: '2026-09-17', to: '2026-09-23' },
    );
    expect(bars.map((b) => b.label)).toEqual(['2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23']);
    expect(bars.map((b) => b.value)).toEqual([0, 0, 0, 900, 0, 0, 2100]);
    expect(barsSumTo(bars, 3000)).toBe(true);
  });

  it('this month: the weeks of the month, cut at today', () => {
    const days = [
      { date: '2026-09-01', value: 10 },
      { date: '2026-09-07', value: 20 },
      { date: '2026-09-08', value: 30 },
      { date: '2026-09-23', value: 40 },
    ];
    const bars = groupedBars(days, { from: '2026-09-01', to: '2026-09-23' });
    expect(bars.map((b) => b.label)).toEqual(['1–7', '8–14', '15–21', '22–23']);
    expect(bars.map((b) => b.value)).toEqual([30, 30, 0, 40]);
    expect(barsSumTo(bars, 100)).toBe(true);
    const full = groupedBars([], { from: '2026-10-01', to: '2026-10-31' });
    expect(full.map((b) => b.label)).toEqual(['1–7', '8–14', '15–21', '22–28', '29–31']);
    expect(groupedBars([], { from: '2026-09-01', to: '2026-09-01' }).map((b) => b.label)).toEqual(['1']);
  });

  it('barsSumTo compares to the cent', () => {
    expect(barsSumTo([{ key: 'a', label: 'a', from: 'a', to: 'a', value: 0.1 }, { key: 'b', label: 'b', from: 'b', to: 'b', value: 0.2 }], 0.3)).toBe(true);
    expect(barsSumTo([{ key: 'a', label: 'a', from: 'a', to: 'a', value: 1 }], 1.01)).toBe(false);
  });
});
