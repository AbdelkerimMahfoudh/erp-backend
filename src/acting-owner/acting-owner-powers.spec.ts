import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ExecutionContext, ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { binToUuid, uuidToBin } from '../common/utils/uuid.util';
import { ROLE_PERMISSIONS } from '../rbac/role-permissions';
import { AccessService } from '../rbac/access.service';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { UserManagementService } from '../users/user-management.service';
import { RoleChangeService } from '../users/role-change.service';
import { AccountDeletionService } from '../account/account-deletion.service';
import { PortalSessionService } from '../platform/portal/portal-session.service';
import { PlatformAdminGuard } from '../platform/platform-admin.guard';
import { ActingOwnerService } from './acting-owner.service';

/**
 * What a temporary Acting Owner may NOT do (D225), each proven against the code path that refuses it, with the
 * appointment IN FORCE: the delegate holds every delegated Owner permission, and still —
 *
 *  - cannot appoint, change or remove an Acting Owner (403 `owner_only`);
 *  - cannot edit the real Owner's name, contacts or access, nor deactivate them (403 `owner_protected`);
 *  - cannot change or demote the real Owner's role (403 `owner_role_fixed`);
 *  - does not hold `integrations.manage` (403 `permission_denied`);
 *  - cannot close the business: their deletion request only ever deletes their own login;
 *  - cannot open the Owner's subscription portal session (403 `owner_only`);
 *  - cannot reach subscription cancellation or the audit log: those are platform-administrator routes, behind a
 *    separate credential no store session carries (401);
 *  - cannot transfer ownership: no route offers it.
 */

const uid = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const id = (n: number) => uuidToBin(uid(n));
const COMPANY = id(1);
const OWNER = id(2);
const DELEGATE = id(3);
const STORE = id(10);

const errorOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as HttpException);
const codeOf = (e: HttpException | null) => (e?.getResponse() as { code?: string } | undefined)?.code;

/** The delegate's resolved permissions with the appointment in force: their Manager role plus the delegated keys. */
function accessWithAppointment() {
  return new AccessService({
    userBranch: { findMany: async () => [{ id: id(500), roleId: id(600), role: { key: 'store_manager' } }] },
    rolePermission: { findMany: async () => ROLE_PERMISSIONS.store_manager.map((key) => ({ permission: { key } })) },
    actingOwnerDelegation: { count: async () => 1 },
    userBranchPermission: { findMany: async () => [] },
  } as never);
}

describe('an Acting Owner in force', () => {
  it('holds the delegated Owner permissions (so every refusal below is not for lack of them)', async () => {
    const held = await accessWithAppointment().getEffectivePermissions(DELEGATE, STORE);
    for (const key of ['user.manage', 'settings.manage']) expect(held.has(key)).toBe(true);
  });

  it('cannot appoint, change or remove an Acting Owner, nor even ask for the code: 403 owner_only', async () => {
    const stepUp = { request: jest.fn(), confirm: jest.fn() };
    const service = new ActingOwnerService(
      { userBranch: { count: async () => 0 } } as never,
      { companyId: () => COMPANY, requireUserId: () => DELEGATE } as never,
      {} as never,
      { verify: async () => true, verifyDummy: async () => false } as never,
      stepUp as never,
    );
    const proof = { currentPassword: 'owner-password', challengeId: uid(900), code: '123456' };
    const attempts = [
      service.requestCode({ action: 'appoint', delegateId: uid(4), currentPassword: 'owner-password' }),
      service.appoint({ delegateId: uid(4), ...proof }),
      // Extending their own appointment = removing it and appointing again: both refused.
      service.requestCode({ action: 'revoke', delegationId: uid(800), currentPassword: 'owner-password' }),
      service.revoke(uid(800), proof),
    ];
    for (const attempt of attempts) {
      const e = await errorOf(attempt);
      expect(e).toBeInstanceOf(ForbiddenException);
      expect(codeOf(e)).toBe('owner_only');
    }
    expect(stepUp.request).not.toHaveBeenCalled();
    expect(stepUp.confirm).not.toHaveBeenCalled();
  });

  it('cannot change the real Owner’s name, contacts or credentials, nor deactivate them: 403 owner_protected', async () => {
    const ownerRow = {
      id: OWNER,
      name: 'Owner',
      nameAr: null,
      phone: '+22231234567',
      email: 'owner@shop.mr',
      isActive: true,
      userBranches: [{ branch: { id: STORE, name: 'Main', nameAr: null }, role: { key: 'owner' }, permissions: [] }],
    };
    const update = jest.fn();
    const service = new UserManagementService(
      { user: { findFirst: async () => ownerRow, update }, userBranch: { count: async () => 0 } } as never,
      { userId: () => DELEGATE, requireUserId: () => DELEGATE, companyId: () => COMPANY } as never,
      {} as never,
      {} as never,
      { verify: async () => true } as never,
    );
    for (const dto of [{ name: 'Somebody else' }, { phone: '+22249999999', currentPassword: 'x' }, { email: 'me@evil.mr', currentPassword: 'x' }, { isActive: false }]) {
      const e = await errorOf(service.update(binToUuid(OWNER), dto as never));
      expect(e).toBeInstanceOf(ForbiddenException);
      expect(codeOf(e)).toBe('owner_protected');
    }
    expect(update).not.toHaveBeenCalled();
  });

  it('cannot change or demote the real Owner’s role: 403 owner_role_fixed', async () => {
    const tx = {
      $queryRaw: async () => [],
      user: { findFirst: async () => ({ id: OWNER, name: 'Owner', isActive: true, userBranches: [{ id: id(501), branchId: STORE, role: { key: 'owner' } }] }) },
      userBranch: { update: jest.fn(), create: jest.fn(), delete: jest.fn() },
    };
    const service = new RoleChangeService(
      { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) } as never,
      { requireUserId: () => DELEGATE, companyId: () => COMPANY } as never,
      {} as never,
      {} as never,
    );
    for (const role of ['store_employee', 'store_manager'] as const) {
      const e = await errorOf(service.change(binToUuid(OWNER), { role, branchIds: [binToUuid(STORE)] }));
      expect(e).toBeInstanceOf(ForbiddenException);
      expect(codeOf(e)).toBe('owner_role_fixed');
    }
    expect(tx.userBranch.update).not.toHaveBeenCalled();
  });

  it('does not hold integrations.manage: a route requiring it answers 403 permission_denied', async () => {
    const store: Record<string, unknown> = { userId: binToUuid(DELEGATE), branchId: STORE };
    const cls = { get: (k: string) => store[k], set: (k: string, v: unknown) => void (store[k] = v) } as unknown as ClsService<never>;
    const ctx = { getHandler: () => ({}), getClass: () => ({}) } as unknown as ExecutionContext;
    const guard = (required: string[]) => {
      delete store.permissions;
      return new PermissionsGuard({ getAllAndOverride: () => required } as unknown as Reflector, accessWithAppointment(), cls as never);
    };
    const e = await errorOf(guard(['integrations.manage']).canActivate(ctx));
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(e!.getResponse()).toMatchObject({ code: 'permission_denied', missing: ['integrations.manage'] });
    // The subscription's renewal requests (seats, stores, activity, payment instructions) are settings.manage: allowed.
    await expect(guard(['settings.manage']).canActivate(ctx)).resolves.toBe(true);
  });

  it('cannot close the business: their deletion request only ever deletes their own login', async () => {
    const service = new AccountDeletionService(
      {
        role: { findFirst: async () => ({ id: id(600) }) },
        // The Owner role is read from user_branches — the delegate has none; the appointment is not consulted.
        userBranch: { findFirst: async ({ where }: { where: { userId: Buffer } }) => (where.userId.equals(OWNER) ? { id: id(501) } : null), findMany: async () => [] },
        user: { count: async () => 0 },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      undefined as never,
    );
    await expect(service.kindFor(COMPANY, DELEGATE)).resolves.toBe('personal_login');
    await expect(service.kindFor(COMPANY, OWNER)).resolves.toBe('company_closure');
  });

  it('cannot open the Owner’s subscription portal session: 403 owner_only', async () => {
    const prisma = {
      user: {
        // The portal accepts only somebody holding the Owner ROLE.
        findFirst: async ({ where }: { where: { id: Buffer; userBranches: { some: { role: { key: string } } } } }) =>
          where.userBranches.some.role.key === 'owner' && where.id.equals(OWNER) ? { name: 'Owner', company: { name: 'Shop' } } : null,
      },
    };
    const portal = new PortalSessionService(prisma as never, {} as never, {} as never, {} as never, {} as never);
    const e = await errorOf(portal.current(binToUuid(DELEGATE), binToUuid(COMPANY), uid(700)));
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(codeOf(e)).toBe('owner_only');
  });

  it('cannot cancel the subscription or read the audit log: platform-administrator routes refuse a store session (401)', async () => {
    const admins = { resolveSession: jest.fn(async () => null) };
    const guard = new PlatformAdminGuard(admins as never);
    const ctx = {
      getHandler: () => ({}),
      switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: 'Bearer a-store-access-token' } }) }),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

/** Every route of the API, read from the controllers' decorators: method, full path, and the guards on it. */
function routeCensus(): { method: string; path: string; platformAdminOnly: boolean; file: string }[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.controllers?\.ts$/.test(name)) files.push(full);
    }
  };
  walk(join(__dirname, '..'));
  const routes: { method: string; path: string; platformAdminOnly: boolean; file: string }[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    // Split per controller class: a file may hold several.
    for (const part of src.split(/(?=@Controller\()/).slice(1)) {
      const base = /@Controller\(\s*(?:'([^']*)'|\{\s*path:\s*'([^']*)')/.exec(part);
      const prefix = base ? (base[1] ?? base[2] ?? '') : '';
      const classAdmin = /@UseGuards\([^)]*PlatformAdminGuard/.test(part.slice(0, part.indexOf('class ')));
      const re = /@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(part))) {
        // The decorators of this handler: everything since the previous handler's closing brace.
        const before = part.slice(0, m.index);
        const decorators = before.slice(Math.max(0, before.lastIndexOf('\n  }\n')));
        routes.push({
          method: m[1].toUpperCase(),
          path: [prefix, m[2] ?? ''].filter(Boolean).join('/'),
          platformAdminOnly: classAdmin || /PlatformAdminGuard/.test(decorators),
          file,
        });
      }
    }
  }
  return routes;
}

describe('the routes a store session could ever reach', () => {
  const routes = routeCensus();

  it('the census reads the API (sanity: the Acting Owner routes are in it)', () => {
    expect(routes).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'POST', path: 'acting-owner/code' }), expect.objectContaining({ method: 'POST', path: 'acting-owner/:id/revoke' })]));
    // …and tells a store route from a platform-administrator one, so the check below can fail.
    expect(routes.find((r) => r.path === 'acting-owner/code')?.platformAdminOnly).toBe(false);
    expect(routes.find((r) => r.path === 'platform/my-subscription/seat-requests' && r.method === 'POST')?.platformAdminOnly).toBe(false);
  });

  it('offer no ownership transfer at all', () => {
    expect(routes.filter((r) => /owner(ship)?[-_/]?transfer|transfer[-_/]?owner/i.test(r.path))).toEqual([]);
  });

  it('cancel a subscription and read the audit log only behind the platform administrator’s guard', () => {
    const sensitive = routes.filter((r) => /(^|\/)audit(\/|$)/i.test(r.path) || /^platform\/businesses\/:id\/cancel$/.test(r.path) || /subscription.*cancel|cancel.*subscription/i.test(r.path));
    expect(sensitive.length).toBeGreaterThan(0);
    for (const r of sensitive) expect({ route: `${r.method} ${r.path}`, platformAdminOnly: r.platformAdminOnly }).toEqual({ route: `${r.method} ${r.path}`, platformAdminOnly: true });
  });
});
