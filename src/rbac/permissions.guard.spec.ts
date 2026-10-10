import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { AppClsStore } from '../common/context/request-context';
import { newUuidV7 } from '../common/utils/uuid.util';
import { AccessService } from './access.service';
import { PermissionsGuard } from './permissions.guard';
import { branchAccessDenied } from './refusals';

function fakeContext(): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
  } as unknown as ExecutionContext;
}

function fakeCls(store: Record<string, unknown>): ClsService<AppClsStore> {
  return {
    get: (key: string) => store[key],
    set: (key: string, value: unknown) => {
      store[key] = value;
    },
  } as unknown as ClsService<AppClsStore>;
}

describe('PermissionsGuard', () => {
  const userId = newUuidV7();

  it('allows when the route requires no permissions', async () => {
    const reflector = { getAllAndOverride: () => undefined } as unknown as Reflector;
    const access = { getEffectivePermissions: jest.fn() } as unknown as AccessService;
    const guard = new PermissionsGuard(reflector, access, fakeCls({ userId }));

    await expect(guard.canActivate(fakeContext())).resolves.toBe(true);
    expect(access.getEffectivePermissions).not.toHaveBeenCalled();
  });

  it('allows when the user has the required permission', async () => {
    const reflector = { getAllAndOverride: () => ['sale.create'] } as unknown as Reflector;
    const access = {
      getEffectivePermissions: jest.fn().mockResolvedValue(new Set(['sale.create', 'report.view'])),
    } as unknown as AccessService;
    const guard = new PermissionsGuard(reflector, access, fakeCls({ userId }));

    await expect(guard.canActivate(fakeContext())).resolves.toBe(true);
  });

  it('denies with 403 when the permission is missing', async () => {
    const reflector = { getAllAndOverride: () => ['discount.override'] } as unknown as Reflector;
    const access = {
      getEffectivePermissions: jest.fn().mockResolvedValue(new Set(['sale.create'])),
    } as unknown as AccessService;
    const guard = new PermissionsGuard(reflector, access, fakeCls({ userId }));

    await expect(guard.canActivate(fakeContext())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('names the refusal and the missing keys, never only a sentence (D161)', async () => {
    /*
     * A phone replaying a queued write after a role change meets this before
     * its key is looked up; it must tell "you may no longer do this" from any
     * other 403 without parsing English. The sentence is the one it always was.
     */
    const reflector = { getAllAndOverride: () => ['agent.transaction.record', 'agent.transaction.view'] } as unknown as Reflector;
    const access = {
      getEffectivePermissions: jest.fn().mockResolvedValue(new Set(['agent.transaction.view'])),
    } as unknown as AccessService;
    const guard = new PermissionsGuard(reflector, access, fakeCls({ userId }));

    const refusal = await guard.canActivate(fakeContext()).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ForbiddenException);
    expect((refusal as ForbiddenException).getResponse()).toEqual({
      code: 'permission_denied',
      message: 'Missing permission(s): agent.transaction.record',
      missing: ['agent.transaction.record'],
    });
  });

  it('lets the branch refusal through untouched: not assigned is not the same as not permitted', async () => {
    const reflector = { getAllAndOverride: () => ['sale.create'] } as unknown as Reflector;
    const access = { getEffectivePermissions: jest.fn().mockRejectedValue(branchAccessDenied()) } as unknown as AccessService;
    const guard = new PermissionsGuard(reflector, access, fakeCls({ userId, branchId: Buffer.alloc(16, 2) }));

    const refusal = await guard.canActivate(fakeContext()).catch((e: unknown) => e);
    expect((refusal as ForbiddenException).getResponse()).toMatchObject({ code: 'branch_access_denied' });
  });
});
