import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException, HttpStatus, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA, VERSION_METADATA } from '@nestjs/common/constants';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClosingModule } from '../closing/closing.module';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { REQUIRE_PERMISSIONS_KEY } from '../rbac/require-permissions.decorator';
import { DELEGATABLE_PERMISSIONS, isCompanyPermission } from '../rbac/permission-scope';
import { ROLE_PERMISSIONS } from '../rbac/role-permissions';
import { AGENT_PERMISSIONS } from './agent-access';
import { AgentController } from './agent.controller';
import { AgentModule } from './agent.module';
import { AgentPositionsService } from './agent-positions.service';
import { AgentProvidersService } from './agent-providers.service';
import { AgentReportsService } from './agent-reports.service';
import { AgentTransactionsService } from './agent-transactions.service';
import { CreateAgentProviderConfigDto, CreateAgentProviderDto, UpdateAgentProviderDto } from './dto/provider.dto';

/**
 * The agent counter's routes and who may reach them (docs/73 §7), the module's
 * place in the API, and the error details the global filter lets through.
 */

const handler = (name: keyof AgentController) => AgentController.prototype[name] as unknown as object;
const perms = (name: keyof AgentController): string[] | undefined => Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, handler(name));
const route = (name: keyof AgentController) => `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler(name)) as number]} ${Reflect.getMetadata(PATH_METADATA, handler(name))}`;

describe('the routes, under agent/ and version 1', () => {
  it('is mounted at agent, version 1', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AgentController)).toBe('agent');
    expect(Reflect.getMetadata(VERSION_METADATA, AgentController)).toBe('1');
  });

  it('each route carries the key of docs/73 §7; the provider list is gated inside on any of the nine', () => {
    const expected: Record<string, [string, string[] | undefined]> = {
      listProviders: ['GET providers', undefined],
      createProvider: ['POST providers', ['agent.provider.manage']],
      updateProvider: ['PATCH providers/:id', ['agent.provider.manage']],
      addProviderConfig: ['POST providers/:id/configs', ['agent.provider.manage']],
      listProviderConfigs: ['GET providers/:id/configs', ['agent.provider.manage']],
      positionsView: ['GET positions', ['agent.transaction.view']],
      setPosition: ['POST positions', ['agent.position.set']],
      recordTransaction: ['POST transactions', ['agent.transaction.record']],
      listTransactions: ['GET transactions', ['agent.transaction.view']],
      getTransaction: ['GET transactions/:id', ['agent.transaction.view']],
      reverseTransaction: ['POST transactions/:id/reverse', ['agent.transaction.reverse']],
      reportMistake: ['POST transactions/:id/mistakes', ['agent.mistake.report']],
      listMistakes: ['GET mistakes', ['agent.transaction.reverse']],
      dismissMistake: ['POST mistakes/:id/dismiss', ['agent.transaction.reverse']],
      createRebalancing: ['POST rebalancings', ['agent.rebalance']],
      listRebalancings: ['GET rebalancings', ['agent.rebalance']],
      report: ['GET reports', ['agent.report.view']],
    };
    for (const [name, [path, keys]] of Object.entries(expected)) {
      expect([name, route(name as keyof AgentController)]).toEqual([name, path]);
      expect([name, perms(name as keyof AgentController)]).toEqual([name, keys]);
    }
  });

  it('the nine keys are the catalogue’s, held as the matrix says: the Owner all, the Manager seven, the Employee three, the Administrator none', () => {
    expect([...AGENT_PERMISSIONS].sort()).toEqual(ROLE_PERMISSIONS.owner.filter((k) => k.startsWith('agent.')).sort());
    expect(ROLE_PERMISSIONS.store_manager.filter((k) => k.startsWith('agent.')).sort()).toEqual(
      ['agent.transaction.record', 'agent.transaction.view', 'agent.customer.reveal', 'agent.mistake.report', 'agent.transaction.reverse', 'agent.rebalance', 'agent.report.view'].sort(),
    );
    expect(ROLE_PERMISSIONS.store_employee.filter((k) => k.startsWith('agent.')).sort()).toEqual(['agent.transaction.record', 'agent.transaction.view', 'agent.mistake.report'].sort());
    expect(ROLE_PERMISSIONS.administrator.filter((k) => k.startsWith('agent.'))).toEqual([]);
    // Setting a position and configuring providers are the Owner's alone: never delegated, resolved in a branch.
    for (const key of ['agent.position.set', 'agent.provider.manage']) {
      expect(DELEGATABLE_PERMISSIONS.has(key)).toBe(false);
      expect(isCompanyPermission(key)).toBe(false);
    }
  });

  it('the module is registered in the API, beside the closing it imports; the closing never imports it', () => {
    // Read as source, as the receiving-files spec does: importing AppModule boots the configuration, which needs a database URL.
    const app = readFileSync(join(__dirname, '..', 'app.module.ts'), 'utf8');
    expect(app).toMatch(/imports:\s*\[[\s\S]*ClosingModule,[\s\S]*AgentModule,/);
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, AgentModule)).toEqual([ClosingModule]);
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AgentModule)).toEqual([AgentController]);
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AgentModule)).toEqual([AgentProvidersService, AgentPositionsService, AgentTransactionsService, AgentReportsService]);
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, ClosingModule)).not.toContain(AgentModule);
  });
});

describe('the provider writes carry a request key (D160)', () => {
  // The pipe as main.ts builds it.
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } });
  const KEY = '01a0b1c2-0000-7000-8000-0000000000d1';

  it('each of the three requires a clientRequestId, and it must be a uuid', async () => {
    for (const [metatype, body] of [
      [CreateAgentProviderDto, { kind: 'sedad', label: 'Sedad' }],
      [UpdateAgentProviderDto, { isActive: false }],
      [CreateAgentProviderConfigDto, { sameRateBothDirections: true, reason: 'the October schedule' }],
    ] as const) {
      const meta = { type: 'body' as const, metatype: metatype as never };
      await expect(pipe.transform({ ...body, clientRequestId: KEY }, meta)).resolves.toBeInstanceOf(metatype);
      for (const bad of [{ ...body }, { ...body, clientRequestId: 'retry-1' }]) {
        const e = await pipe.transform(bad, meta).catch((err: unknown) => err);
        expect([metatype.name, e]).toEqual([metatype.name, expect.any(BadRequestException)]);
        expect(JSON.stringify((e as BadRequestException).getResponse())).toContain('clientRequestId must be a UUID');
      }
    }
  });

  it('a replay answers 200 — this request created nothing; a first write keeps its 201', async () => {
    for (const [replayed, status] of [
      [false, undefined],
      [true, HttpStatus.OK],
    ] as const) {
      const providers = { create: jest.fn(async () => ({ id: 'p', replayed })), addConfig: jest.fn(async () => ({ config: {}, provider: {}, replayed })) };
      const controller = new AgentController(providers as never, {} as never, {} as never, {} as never);
      for (const call of [
        (res: never) => controller.createProvider({} as never, res),
        (res: never) => controller.addProviderConfig('01a0b1c2-0000-7000-8000-00000000000b', {} as never, res),
      ]) {
        const res = { status: jest.fn() };
        await expect(call(res as never)).resolves.toMatchObject({ replayed });
        expect(res.status.mock.calls.map(([s]) => s)).toEqual(status === undefined ? [] : [status]);
      }
    }
  });
});

describe('the details the global filter lets through (docs/73)', () => {
  function runFilter(exception: unknown): Record<string, unknown> {
    let captured: Record<string, unknown> = {};
    const response = { status: () => response, json: (body: Record<string, unknown>) => ((captured = body), response) };
    const host = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ url: '/api/v1/agent/transactions' }) }) };
    new AllExceptionsFilter({ error: () => undefined, warn: () => undefined } as never, { getId: () => 'req-1', get: () => 'req-1' } as never).catch(exception, host as never);
    return captured;
  }

  it('provider_not_configured names the blanks; stale_configuration names both versions; float_count_required lists the providers; activity_not_subscribed says which and what is needed', () => {
    expect(runFilter(new ConflictException({ code: 'provider_not_configured', message: 'm', missing: ['rateInBp'] }))).toMatchObject({ statusCode: 409, code: 'provider_not_configured', missing: ['rateInBp'] });
    expect(runFilter(new ConflictException({ code: 'stale_configuration', message: 'm', expectedConfigVersionId: 'a', currentConfigVersionId: 'b' }))).toMatchObject({ expectedConfigVersionId: 'a', currentConfigVersionId: 'b' });
    expect(runFilter(new ConflictException({ code: 'float_count_required', message: 'm', providers: [{ providerId: 'p', label: 'Bankily' }] }))).toMatchObject({ providers: [{ providerId: 'p', label: 'Bankily' }] });
    expect(runFilter(new ForbiddenException({ code: 'activity_not_subscribed', message: 'm', activity: 'electronics', required: 'money_agent' }))).toMatchObject({ statusCode: 403, activity: 'electronics', required: 'money_agent' });
  });

  it('and still nothing else', () => {
    const body = runFilter(new ConflictException({ code: 'x', message: 'm', customerNumber: '36123456', sql: 'SELECT 1' }));
    expect(body).not.toHaveProperty('customerNumber');
    expect(body).not.toHaveProperty('sql');
  });
});
