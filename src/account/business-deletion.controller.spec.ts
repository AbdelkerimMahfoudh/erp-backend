import { ForbiddenException } from '@nestjs/common';
import { BusinessDeletionController } from './business-deletion.controller';

/**
 * Both deletion steps stand behind the open step-up window (post-Build-4): with none — never opened, or its five minutes
 * over — the controller refuses before the service is reached, whatever the body carries.
 */
describe('the business deletion routes need the step-up window', () => {
  const admin = { id: Buffer.alloc(16, 1), email: 'ops@example.test', name: 'Ops' };
  const req = { platformAdmin: admin, ip: '127.0.0.1' } as never;

  function harness(windowOpen: boolean) {
    const admins = { requireStepUp: jest.fn(async () => { if (!windowOpen) throw new ForbiddenException({ code: 'step_up_required' }); }) };
    const deletions = { view: jest.fn(), prepare: jest.fn(async () => ({ stage: 'prepared' })), delete: jest.fn(async () => ({ stage: 'completed' })) };
    return { admins, deletions, controller: new BusinessDeletionController(admins as never, deletions as never) };
  }

  it('an expired or absent window refuses prepare and delete, and the service is never called', async () => {
    const h = harness(false);
    await expect(h.controller.prepare('id', {}, req)).rejects.toMatchObject({ response: { code: 'step_up_required' } });
    await expect(h.controller.delete('id', { confirmName: 'Boutique', confirmPassword: 'a password is not enough' }, req)).rejects.toMatchObject({ response: { code: 'step_up_required' } });
    expect(h.deletions.prepare).not.toHaveBeenCalled();
    expect(h.deletions.delete).not.toHaveBeenCalled();
  });

  it('an open window lets each step through to the service, which applies its own checks', async () => {
    const h = harness(true);
    await expect(h.controller.prepare('id', {}, req)).resolves.toMatchObject({ stage: 'prepared' });
    await expect(h.controller.delete('id', { confirmName: 'Boutique' }, req)).resolves.toMatchObject({ stage: 'completed' });
    expect(h.admins.requireStepUp).toHaveBeenCalledTimes(2);
    expect(h.deletions.delete).toHaveBeenCalledWith('id', 'Boutique', { admin, ip: '127.0.0.1' });
  });
});
