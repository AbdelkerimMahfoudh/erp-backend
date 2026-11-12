import { BadRequestException } from '@nestjs/common';
import { PaymentProofsController } from './payment-proofs.controller';

/**
 * Owner, 2026-11-12: the console reads one business's proofs — approved and refused included — in its payment history,
 * to view them without downloading. The queue without `company` is unchanged.
 */
describe('the console’s proofs of one business', () => {
  const calls: unknown[][] = [];
  const proofs = {
    listForCompany: async (...a: unknown[]) => (calls.push(['company', ...a]), [{ id: 'p1', status: 'approved' }, { id: 'p2', status: 'refused' }]),
    listForAdmin: async (...a: unknown[]) => (calls.push(['queue', ...a]), []),
  };
  const controller = new PaymentProofsController(proofs as never, {} as never, {} as never, {} as never);

  beforeEach(() => (calls.length = 0));

  it('lists every decision of that business, by its id', async () => {
    const id = '01a16d60-9591-71b5-95cd-e8492c5916e1';
    await expect(controller.list(undefined, id)).resolves.toEqual([{ id: 'p1', status: 'approved' }, { id: 'p2', status: 'refused' }]);
    expect(calls).toEqual([['company', Buffer.from(id.replace(/-/g, ''), 'hex')]]);
  });

  it('refuses a business that is not an id; without one, the review queue as before', async () => {
    expect(() => controller.list(undefined, 'abc')).toThrow(BadRequestException);
    await controller.list('approved');
    expect(calls).toEqual([['queue', 'approved']]);
  });
});
