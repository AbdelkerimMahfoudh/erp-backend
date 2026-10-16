import 'reflect-metadata';
import { type INestApplication, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ExpensesController } from '../../expenses/expenses.controller';
import { ExpensesService } from '../../expenses/expenses.service';
import { MAX_RECEIPT_BYTES } from '../../expenses/receipt-rules';
import { ImportsController } from '../../imports/imports.controller';
import { ImportsService } from '../../imports/imports.service';
import { ReceivingFilesController } from '../../receiving-files/receiving-files.controller';
import { MAX_FILE_BYTES, ReceivingFilesService } from '../../receiving-files/receiving-files.service';
import { PermissionsGuard } from '../../rbac/permissions.guard';

/**
 * Every upload route refuses an oversized or malformed form before its handler runs (docs/48 control 8).
 *
 * The three real controllers, through Nest's real FileInterceptor and multer, over HTTP. A legitimate form reaches
 * the service; a file one byte over the route's cap, a second file, too many fields or an overlong field name is
 * refused and the service is never called.
 */

const ROUTES = [
  { name: 'stock import', path: '/api/v1/imports', max: 10 * 1024 * 1024, field: 'clientUuid' },
  { name: 'delivery file', path: '/api/v1/purchases/file/parse', max: MAX_FILE_BYTES, field: 'sheet' },
  { name: 'expense receipt', path: '/api/v1/expenses/e1/receipt', max: MAX_RECEIPT_BYTES, field: 'note' },
] as const;

describe('upload limits on every multipart route', () => {
  let app: INestApplication;
  const calls: string[] = [];

  beforeAll(async () => {
    const handled = (name: string) => async () => (calls.push(name), { ok: true });
    const moduleRef = await Test.createTestingModule({
      controllers: [ImportsController, ReceivingFilesController, ExpensesController],
      providers: [
        { provide: ImportsService, useValue: { preview: handled('imports') } },
        { provide: ReceivingFilesService, useValue: { parse: handled('receiving') } },
        { provide: ExpensesService, useValue: { attachReceipt: handled('expenses') } },
      ],
    })
      // Permissions are proven elsewhere; here every caller is allowed, so only the form decides.
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
  });

  afterAll(() => app.close());
  beforeEach(() => (calls.length = 0));

  describe.each(ROUTES)('$name', (route) => {
    it('accepts one file at the cap with its field', async () => {
      const res = await request(app.getHttpServer())
        .post(route.path)
        .attach('file', Buffer.alloc(route.max), 'a.bin')
        .field(route.field, 'x');
      expect(res.status).toBeLessThan(300);
      expect(calls).toHaveLength(1);
    });

    it('refuses a file one byte over the cap (413)', async () => {
      const res = await request(app.getHttpServer())
        .post(route.path)
        .attach('file', Buffer.alloc(route.max + 1), 'a.bin');
      expect(res.status).toBe(413);
      expect(calls).toHaveLength(0);
    });

    it('refuses a second file', async () => {
      const res = await request(app.getHttpServer())
        .post(route.path)
        .attach('file', Buffer.from('a'), 'a.bin')
        .attach('file', Buffer.from('b'), 'b.bin');
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it('refuses more fields than any form sends', async () => {
      let req = request(app.getHttpServer()).post(route.path).attach('file', Buffer.from('a'), 'a.bin');
      for (let i = 0; i < 9; i++) req = req.field(`f${i}`, 'x');
      const res = await req;
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it('refuses an overlong, deeply nested field name', async () => {
      const res = await request(app.getHttpServer())
        .post(route.path)
        .field('a' + '[0]'.repeat(500), 'x')
        .attach('file', Buffer.from('a'), 'a.bin');
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });
  });
});
