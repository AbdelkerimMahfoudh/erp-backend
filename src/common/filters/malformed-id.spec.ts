import 'reflect-metadata';
import { type INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { CategoriesController } from '../../categories/categories.controller';
import { CategoriesService } from '../../categories/categories.service';
import { PermissionsGuard } from '../../rbac/permissions.guard';
import { TENANT_PRISMA } from '../../prisma/prisma.module';
import { TenantContext } from '../tenant/tenant-context.service';
import { AuditService } from '../audit/audit.service';
import { ProductAttributesService } from '../../tracking/product-attributes.service';
import { InvalidUuidError, uuidToBin } from '../utils/uuid.util';
import { AllExceptionsFilter } from './all-exceptions.filter';

/**
 * A record id that is not a uuid is the client's mistake: 400 `id_invalid`, never a 500.
 *
 * Found over real HTTP (2026-10-16): nine tenant routes answered 500 for `abc` as the id — GET and PATCH
 * /categories/:id, GET /debt/:userId, GET /discrepancies/:id, GET /imports/:id, POST /imports/:id/commit,
 * GET /pricing/products/:productId, POST /units/:id/faulty, POST /users/:id/cancel-invitation — because the id reached
 * `uuidToBin`, whose plain Error the filter could only call a server error. The categories routes stand for all of
 * them: the real controller, the real service, the real filter and the app's validation, over HTTP.
 */

describe('a malformed record id', () => {
  let app: INestApplication;
  const db = { productCategory: { findUnique: jest.fn(), update: jest.fn() } };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CategoriesController],
      providers: [
        CategoriesService,
        { provide: TENANT_PRISMA, useValue: db },
        { provide: TenantContext, useValue: { companyId: () => Buffer.alloc(16, 1) } },
        { provide: AuditService, useValue: { record: jest.fn() } },
        { provide: ProductAttributesService, useValue: {} },
      ],
    })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    const logger = { error: jest.fn(), warn: jest.fn() };
    app.useGlobalFilters(new AllExceptionsFilter(logger as never, { getId: () => 'req-1', get: () => 'req-1' } as never));
    await app.init();
  });

  afterAll(() => app.close());

  it.each([
    ['GET', 'abc'],
    ['GET', '1----'],
    ['PATCH', 'abc'],
  ])('%s /categories/%s answers 400 id_invalid and reads nothing', async (method, id) => {
    const call = request(app.getHttpServer())[method === 'GET' ? 'get' : 'patch'](`/api/v1/categories/${id}`);
    const res = method === 'GET' ? await call : await call.send({ name: 'Phones' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'id_invalid', message: 'That record id is not valid.' });
    expect(db.productCategory.findUnique).not.toHaveBeenCalled();
    expect(db.productCategory.update).not.toHaveBeenCalled();
  });

  it('a well-formed id that names nothing is still not found, not a client mistake', async () => {
    db.productCategory.findUnique.mockResolvedValueOnce(null);

    const res = await request(app.getHttpServer()).get('/api/v1/categories/0192f3a0-0000-7000-8000-000000000001');

    expect(res.status).toBe(404);
  });

  it('uuidToBin throws its own class, so nothing else is answered as a malformed id', () => {
    expect(() => uuidToBin('abc')).toThrow(InvalidUuidError);
    expect(new InvalidUuidError('abc')).toBeInstanceOf(Error);
  });
});
