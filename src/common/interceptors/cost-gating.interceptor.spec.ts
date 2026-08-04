import { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { CostGatingInterceptor } from './cost-gating.interceptor';

function makeCls(store: Record<string, unknown>) {
  return {
    get: (k: string) => store[k],
    set: (k: string, v: unknown) => {
      store[k] = v;
    },
  };
}
const ctx = { switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }) } as unknown as ExecutionContext;
const handlerOf = (data: unknown): CallHandler => ({ handle: () => of(data) });
const payload = () => ({ total: 100, margin: 40, items: [{ price: 50, cost: 20 }] });

describe('CostGatingInterceptor', () => {
  const userId = '018f0000-0000-7000-8000-000000000009';

  it('passes financial fields through when the caller has cost.view', async () => {
    const cls = makeCls({ userId, permissions: new Set(['cost.view']) });
    const access = { getEffectivePermissions: jest.fn() };
    const int = new CostGatingInterceptor(cls as any, access as any);

    const result = await lastValueFrom(await int.intercept(ctx, handlerOf(payload())));
    expect(result).toEqual(payload());
    expect(access.getEffectivePermissions).not.toHaveBeenCalled();
  });

  it('strips financial fields when the caller lacks cost.view', async () => {
    const cls = makeCls({ userId, permissions: new Set(['sale.create']) });
    const int = new CostGatingInterceptor(cls as any, { getEffectivePermissions: jest.fn() } as any);

    const result = await lastValueFrom(await int.intercept(ctx, handlerOf(payload())));
    expect(result).toEqual({ total: 100, items: [{ price: 50 }] });
  });

  it('resolves permissions on demand when the route did not (and caches them)', async () => {
    const store: Record<string, unknown> = { userId };
    const cls = makeCls(store);
    const access = { getEffectivePermissions: jest.fn().mockResolvedValue(new Set(['sale.create'])) };
    const int = new CostGatingInterceptor(cls as any, access as any);

    const result = await lastValueFrom(await int.intercept(ctx, handlerOf(payload())));
    expect(access.getEffectivePermissions).toHaveBeenCalledTimes(1);
    expect(store.permissions).toBeInstanceOf(Set);
    expect(result).toEqual({ total: 100, items: [{ price: 50 }] });
  });

  it('passes through unauthenticated requests untouched', async () => {
    const cls = makeCls({});
    const access = { getEffectivePermissions: jest.fn() };
    const int = new CostGatingInterceptor(cls as any, access as any);

    const result = await lastValueFrom(await int.intercept(ctx, handlerOf(payload())));
    expect(result).toEqual(payload());
    expect(access.getEffectivePermissions).not.toHaveBeenCalled();
  });
});
