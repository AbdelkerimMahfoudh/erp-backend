import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { AppClsStore } from '../common/context/request-context';
import { newUuidV7 } from '../common/utils/uuid.util';
import { AccessService } from './access.service';
import { PermissionsGuard } from './permissions.guard';

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
});
