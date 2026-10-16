import 'reflect-metadata';
import { BadRequestException, RequestMethod, ServiceUnavailableException } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { AppRegistrationController } from './app-registration.controller';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformController, PUBLIC_THROTTLE } from './platform.controller';
import { RegistrationFlowService } from './registration-flow.service';
import { RegistrationService } from './registration.service';

/**
 * A business registering itself through either door (0095, the owner's decision Q1 of 2026-10-13): the website's
 * `platform/register*` and the app's `auth/register*` are one flow. Same validation, same refusal before anything is
 * saved, same continuation, same Owner session — and the same free trial eligibility: eligible, never started. The
 * console's own route never makes a business eligible.
 */

const stub = {} as never;
type Handler = (...args: unknown[]) => unknown;

const DOORS = [
  ['register', 'register', HttpStatusOf(201)],
  ['continueStart', 'register/verify/start', HttpStatusOf(200)],
  ['continueConfirm', 'register/verify/confirm', HttpStatusOf(200)],
] as const;
function HttpStatusOf(code: number) {
  return code;
}

function meta(cls: { prototype: object }, name: string) {
  const handler = (cls.prototype as Record<string, Handler>)[name];
  return {
    path: `${Reflect.getMetadata(PATH_METADATA, cls)}/${Reflect.getMetadata(PATH_METADATA, handler)}`,
    method: Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod,
    code: Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number,
    isPublic: Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true,
    adminGuard: ((Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as unknown[]).includes(PlatformAdminGuard),
    limit: Reflect.getMetadata('THROTTLER:LIMITdefault', handler) as number,
    ttl: Reflect.getMetadata('THROTTLER:TTLdefault', handler) as number,
  };
}

/** A flow that records what each door handed it. */
function recordingFlow() {
  const calls: [string, unknown[]][] = [];
  const record = (method: string) => async (...args: unknown[]) => {
    calls.push([method, args]);
    return { from: method };
  };
  return {
    calls,
    flow: {
      register: record('register'),
      startVerification: record('startVerification'),
      confirmVerification: record('confirmVerification'),
    } as unknown as RegistrationFlowService,
  };
}

const platformWith = (over: Partial<Record<string, unknown>> = {}) =>
  new PlatformController(
    (over.prisma ?? stub) as never,
    (over.admins ?? stub) as never,
    (over.audit ?? stub) as never,
    (over.lifecycle ?? stub) as never,
    (over.registration ?? stub) as never,
    (over.billing ?? stub) as never,
    (over.entitlement ?? stub) as never,
    (over.tenant ?? stub) as never,
    stub,
    (over.invitations ?? stub) as never,
    (over.flow ?? stub) as never,
  );

const ATTEMPT = {
  idempotencyKey: 'k-1',
  ownerName: 'Aicha',
  businessName: 'Boutique Aicha',
  branchName: 'Main',
  email: 'aicha@example.test',
  password: 'password-1',
  language: 'en' as const,
};

describe('two doors, one registration: the website’s platform/register* and the app’s auth/register*', () => {
  it.each(DOORS)('%s: public, throttled alike, the same method and status — under platform/ and under auth/', (name, path, code) => {
    const website = meta(PlatformController, name);
    const app = meta(AppRegistrationController, name);
    expect(website).toEqual({ ...app, path: `platform/${path}` });
    expect(app).toEqual({
      path: `auth/${path}`,
      method: RequestMethod.POST,
      code,
      isPublic: true,
      adminGuard: false,
      limit: PUBLIC_THROTTLE.default.limit,
      ttl: PUBLIC_THROTTLE.default.ttl,
    });
  });

  it('the app’s controller has these three routes and no other', () => {
    const proto = AppRegistrationController.prototype as unknown as Record<string, Handler>;
    const routes = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && Reflect.hasMetadata(PATH_METADATA, proto[n]));
    expect(routes.sort()).toEqual(['continueConfirm', 'continueStart', 'register']);
  });

  it('each door hands its body to the shared flow unchanged — nothing is decided twice', async () => {
    const website = recordingFlow();
    const app = recordingFlow();
    const req = { ip: '10.0.0.7', headers: { 'user-agent': 'Dukan/1.0' } };
    const confirm = { continuation: 'c'.repeat(43), code: '123456' };
    const start = { continuation: 'c'.repeat(43), language: 'fr' as const };

    const platform = platformWith({ flow: website.flow });
    const appDoor = new AppRegistrationController(app.flow);
    await platform.register(ATTEMPT as never);
    await platform.continueStart(start as never);
    await platform.continueConfirm(confirm as never, req as never);
    await appDoor.register(ATTEMPT as never);
    await appDoor.continueStart(start as never);
    await appDoor.continueConfirm(confirm as never, req as never);

    expect(app.calls).toEqual(website.calls);
    expect(website.calls).toEqual([
      ['register', [ATTEMPT]],
      ['startVerification', [start]],
      ['confirmVerification', [confirm, { ip: '10.0.0.7', userAgent: 'Dukan/1.0' }]],
    ]);
  });
});

describe('the shared flow', () => {
  function flowWith(opts: { deliver?: boolean; pending?: boolean; trialEligible?: boolean } = {}) {
    const seen: Record<string, unknown>[] = [];
    const registration = {
      register: async (input: Record<string, unknown>) => {
        seen.push(input);
        return {
          companyId: binToUuid(newUuidV7Bin()),
          publicStoreId: 'ABCDEF0123',
          branchId: 'b',
          activity: 'electronics',
          ownerUserId: 'u',
          status: 'pending_activation',
          created: true,
          trialEligible: opts.trialEligible ?? true,
        };
      },
      pendingOwnerFor: async () =>
        opts.pending === false
          ? null
          : { companyId: Buffer.alloc(16, 1), userId: Buffer.alloc(16, 2), destinationMasked: 'ai***@example.test', channel: 'email' },
    };
    const continuation = {
      issue: async () => ({ token: 't'.repeat(43), expiresAt: '2026-10-13T10:15:00.000Z' }),
      startChallenge: async (token: string) => (token === 'good'.repeat(5) ? { ok: true, destination: 'x', delivery: 'outbox' } : { ok: false, reason: 'not_found' }),
      complete: async (token: string) =>
        token === 'good'.repeat(5)
          ? { ok: true, accessToken: 'a', refreshToken: 'r', expiresIn: 900, companyId: 'c', userId: 'u' }
          : { ok: false, reason: 'wrong_code' },
    };
    const delivery = { canDeliver: () => opts.deliver ?? true };
    return { seen, flow: new RegistrationFlowService(registration as never, continuation as never, delivery as never) };
  }

  it('makes a business that registers itself eligible for its one free trial — eligible, never started', async () => {
    const { seen, flow } = flowWith();
    const answer = await flow.register(ATTEMPT as never);
    expect(seen).toEqual([expect.objectContaining({ trialEligible: true, idempotencyKey: 'k-1' })]);
    expect(answer).toMatchObject({ status: 'pending_activation', created: true, trialEligible: true, next: 'verify_contact' });
    expect(answer.continuation).toMatchObject({ token: 't'.repeat(43), expiresInSeconds: 900 });
    // Nothing in the answer says a trial runs, or hands out anything but the continuation.
    expect(JSON.stringify(answer)).not.toMatch(/trial_active|startedAt|endsAt|accessToken/);
  });

  it('says what the business holds on a retry, as registration recorded it', async () => {
    const { flow } = flowWith({ trialEligible: false, pending: false });
    await expect(flow.register(ATTEMPT as never)).resolves.toMatchObject({ trialEligible: false, continuation: null, next: 'sign_in' });
  });

  it('refuses up front with registration_unavailable when no code can be sent — on either door, nothing saved', async () => {
    const { seen, flow } = flowWith({ deliver: false });
    for (const door of [platformWith({ flow }), new AppRegistrationController(flow)]) {
      const refusal = await door.register(ATTEMPT as never).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(ServiceUnavailableException);
      expect((refusal as ServiceUnavailableException).getResponse()).toMatchObject({ code: 'registration_unavailable' });
    }
    expect(seen).toEqual([]);
  });

  it('finishes with one ordinary Owner session — and refuses with one shape for every failure', async () => {
    const { flow } = flowWith();
    await expect(flow.confirmVerification({ continuation: 'good'.repeat(5), code: '123456' }, {})).resolves.toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      expiresIn: 900,
    });
    await expect(flow.confirmVerification({ continuation: 'bad'.repeat(6), code: '1' }, {})).rejects.toThrow(
      new BadRequestException('That code did not match.'),
    );
    await expect(flow.startVerification({ continuation: 'good'.repeat(5), language: 'en' })).resolves.toEqual({ delivery: 'outbox' });
    await expect(flow.startVerification({ continuation: 'bad'.repeat(6), language: 'en' })).rejects.toThrow(
      new BadRequestException('That registration cannot be continued.'),
    );
  });

  it('the Super Admin’s console never makes a business eligible', async () => {
    const seen: Record<string, unknown>[] = [];
    const platform = platformWith({
      admins: { confirmPassword: async () => undefined },
      registration: {
        register: async (input: Record<string, unknown>) => {
          seen.push(input);
          return { companyId: binToUuid(newUuidV7Bin()), publicStoreId: 'P', created: true, status: 'pending_activation', trialEligible: false };
        },
      },
      audit: { record: async () => undefined },
      invitations: { issue: async () => ({ token: 'i', expiresAt: new Date(), delivery: 'manual', owner: {} }) },
    });
    const req = { platformAdmin: { id: Buffer.alloc(16, 3), email: 'ops@example.test', name: 'Ops' }, ip: '127.0.0.1' };
    const answer = await platform.createBusiness(
      { idempotencyKey: 'a-1', ownerName: 'O', businessName: 'B', language: 'en', reason: 'by phone' } as never,
      req as never,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].trialEligible).toBeUndefined();
    // Stored under the console's prefix, whole: the DTO leaves room for it (C11).
    expect(seen[0].idempotencyKey).toBe('admin:a-1');
    expect(answer).toMatchObject({ trialEligible: false });
  });
});

describe('every contact given must be able to receive its code, or nothing is saved (C10; review finding R2-3)', () => {
  /**
   * The real registration, on a database that records every table it is asked for and refuses them all: a refusal
   * made before anything is saved touches none — no attempt, no company, no Owner, no eligibility, no event.
   */
  function realFlow(canDeliver: (channel: string) => boolean) {
    const touched: string[] = [];
    const prisma = new Proxy(
      {},
      {
        get: (_db, table: string) => {
          touched.push(table);
          return new Proxy({}, { get: () => async () => { throw new Error(`the database was reached (${table})`); } });
        },
      },
    );
    const registration = new RegistrationService(prisma as never, {} as never, { now: () => new Date() });
    const flow = new RegistrationFlowService(registration, {} as never, { canDeliver } as never);
    return { flow, touched };
  }

  async function refusalOf(flow: RegistrationFlowService, attempt: object): Promise<Record<string, unknown>> {
    const refusal = await flow.register(attempt as never).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ServiceUnavailableException);
    return (refusal as ServiceUnavailableException).getResponse() as Record<string, unknown>;
  }

  const BOTH = { ...ATTEMPT, phone: '+22243210987' };

  it('an email and a WhatsApp number while WhatsApp codes cannot be sent: refused, naming the number — nothing saved', async () => {
    const { flow, touched } = realFlow((channel) => channel === 'email');
    expect(await refusalOf(flow, BOTH)).toEqual({
      code: 'registration_unavailable',
      message: 'Registration cannot be completed right now: a verification code cannot be sent to every contact given. Nothing was saved.',
      unavailableContacts: ['phone'],
    });
    expect(touched).toEqual([]);
  });

  it('the email cannot receive one: refused, naming the email', async () => {
    const { flow, touched } = realFlow((channel) => channel === 'phone');
    expect(await refusalOf(flow, BOTH)).toMatchObject({ code: 'registration_unavailable', unavailableContacts: ['email'] });
    expect(await refusalOf(flow, ATTEMPT)).toMatchObject({ unavailableContacts: ['email'] });
    expect(touched).toEqual([]);
  });

  it('neither can: refused, naming both, email first', async () => {
    const { flow, touched } = realFlow(() => false);
    expect(await refusalOf(flow, BOTH)).toMatchObject({ code: 'registration_unavailable', unavailableContacts: ['email', 'phone'] });
    expect(await refusalOf(flow, { ...BOTH, email: undefined })).toMatchObject({ unavailableContacts: ['phone'] });
    expect(touched).toEqual([]);
  });

  it('on either door alike', async () => {
    const { flow } = realFlow((channel) => channel === 'email');
    for (const door of [platformWith({ flow }), new AppRegistrationController(flow)]) {
      const refusal = await door.register(BOTH as never).catch((e: unknown) => e);
      expect((refusal as ServiceUnavailableException).getResponse()).toMatchObject({ unavailableContacts: ['phone'] });
    }
  });

  it('a contact left blank is not a contact given: the email alone goes through to the registration', async () => {
    const { flow, touched } = realFlow((channel) => channel === 'email');
    // The real registration starts at the database — which this one refuses — so reaching it is the proof.
    await expect(flow.register({ ...ATTEMPT, phone: '   ' } as never)).rejects.toThrow('the database was reached (registrationAttempt)');
    expect(touched).toEqual(['registrationAttempt']);
  });
});
