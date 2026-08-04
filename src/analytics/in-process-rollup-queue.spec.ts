import { InProcessRollupQueue } from './in-process-rollup-queue';
import { RollupService } from './rollup.service';

describe('InProcessRollupQueue', () => {
  const company = Buffer.alloc(16, 1);
  const branch = Buffer.alloc(16, 2);
  const job = { companyId: company, branchId: branch, day: '2026-07-30' };

  it('delegates the recompute to RollupService with the job fields', async () => {
    const rollups = { recomputeDaily: jest.fn().mockResolvedValue(undefined) };
    const queue = new InProcessRollupQueue(rollups as unknown as RollupService);

    queue.enqueueDailyRecompute(job);
    await Promise.resolve(); // flush the fire-and-forget microtask

    expect(rollups.recomputeDaily).toHaveBeenCalledWith(company, branch, '2026-07-30');
  });

  it('swallows a recompute failure (never throws to the caller)', async () => {
    const rollups = { recomputeDaily: jest.fn().mockRejectedValue(new Error('db down')) };
    const queue = new InProcessRollupQueue(rollups as unknown as RollupService);
    jest.spyOn((queue as any).log, 'error').mockImplementation(() => undefined);

    expect(() => queue.enqueueDailyRecompute(job)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect((queue as any).log.error).toHaveBeenCalled();
  });
});
