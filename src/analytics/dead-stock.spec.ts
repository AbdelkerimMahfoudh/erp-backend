import { DashboardService } from './dashboard.service';
import * as movement from './movement';
import { binToUuid } from '../common/utils/uuid.util';

/**
 * "Not moving" is stock that has sat on the shelf for the shop's
 * `dead_stock_days` with no sale that stands inside that window.
 *
 * A product received this week and not yet sold is NEW. It used to be listed
 * as dead on the day it arrived: the list asked when the product last sold and
 * never how long its stock had been there, so every fresh delivery of a model
 * that had not sold before opened the dashboard as dead stock.
 */
const DAY = 86_400_000;
const COMPANY = Buffer.alloc(16, 1);
const BRANCH = Buffer.alloc(16, 2);
const NEW = Buffer.alloc(16, 0x11);
const OLD = Buffer.alloc(16, 0x22);
const SELLING = Buffer.alloc(16, 0x33);
const hex = (b: Buffer) => b.toString('hex');
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

function valuation(productId: Buffer, value: number) {
  return { productId, trackingType: 'imei', unitsCount: 1, quantity: 0, inventoryValue: value };
}

function dashboard(): DashboardService {
  const svc: any = Object.create(DashboardService.prototype);
  svc.tenant = { branchId: () => BRANCH, companyId: () => COMPANY };
  svc.db = { inventoryValuation: { findMany: async () => [valuation(NEW, 300), valuation(OLD, 200), valuation(SELLING, 100)] } };
  svc.numberSetting = async () => 60;
  svc.productLabels = async () => new Map();
  svc.windowStart = () => daysAgo(30);
  return svc;
}

describe('dead stock is stock that has sat, not stock that just arrived', () => {
  let stockedSince: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(movement, 'productMovement').mockResolvedValue(new Map([[hex(SELLING), { sold30d: 1, lastSoldAt: daysAgo(2) }]]));
    stockedSince = jest.spyOn(movement, 'stockedSinceByProduct').mockResolvedValue(
      new Map([
        [hex(NEW), daysAgo(3)],
        [hex(OLD), daysAgo(90)],
        [hex(SELLING), daysAgo(90)],
      ]),
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it('lists stock older than the window with no sale inside it — and nothing else', async () => {
    const dead = await dashboard().deadStock();
    expect(dead.map((d) => d.productId)).toEqual([binToUuid(OLD)]);
    expect(dead[0]).toMatchObject({ inStock: 1, inventoryValue: 200, lastSoldAt: null });
  });

  it('a product received inside the window is new, not dead, even with no sale yet', async () => {
    const dead = await dashboard().deadStock();
    expect(dead.some((d) => d.productId === binToUuid(NEW))).toBe(false);
  });

  it('a product that sold inside the window is moving', async () => {
    const dead = await dashboard().deadStock();
    expect(dead.some((d) => d.productId === binToUuid(SELLING))).toBe(false);
  });

  it('asks how long the stock has been there for this branch', async () => {
    await dashboard().deadStock();
    expect(stockedSince).toHaveBeenCalledWith(expect.anything(), COMPANY, BRANCH);
  });

  it('stock with no arrival on record is not called dead', async () => {
    stockedSince.mockResolvedValue(new Map());
    expect(await dashboard().deadStock()).toEqual([]);
  });
});
