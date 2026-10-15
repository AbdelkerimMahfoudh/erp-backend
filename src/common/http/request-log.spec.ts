import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  type INestApplication,
  Post,
  Res,
  UnauthorizedException,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { ClsModule } from 'nestjs-cls';
import { Logger, LoggerModule } from 'nestjs-pino';
import request from 'supertest';
import { AppConfigService } from '../config/app-config.service';
import { AllExceptionsFilter } from '../filters/all-exceptions.filter';
import { newUuidV7 } from '../utils/uuid.util';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsAppReadiness } from '../../messaging/delivery-readiness';
import { WhatsAppWebhookController } from '../../messaging/whatsapp-webhook.controller';
import { requestLogOptions } from './request-log';

/**
 * No secret ever reaches a log — on a request that succeeds or one that fails (C16; review finding R3-3).
 *
 * The real logging pipeline, booted as `main.ts` and `AppModule` boot it: the app's own pino-http options
 * (`requestLogOptions`, production form — JSON lines, no pretty transport) writing to a capturing destination, Nest
 * routed through pino, and the real `AllExceptionsFilter`, ValidationPipe, ThrottlerGuard and versioned global prefix.
 * Every request carries every secret this API ever receives — in the query string, in the headers and in the body:
 * the setup link's token, the portal ticket, a bearer token, the session cookies, a refresh token, an OTP / deletion /
 * MFA code, a recovery code, the registration continuation, a password, an invitation token, the MFA enrolment token,
 * a device secret, the provisioning key and the WhatsApp webhook's verify token — and each status is produced: 200,
 * 302, 400 (a refused body and a body that is not JSON), 401, 403, 404, 429 and 500.
 *
 * Then nothing of any of them may appear anywhere in what was written, while every request is still followable: its
 * method, its path with the secret replaced, and its status.
 */

const fresh = (bytes = 24) => randomBytes(bytes).toString('base64url');
/** A code is digits; twelve of them, so no timestamp, port or pid in a log line can contain it by chance. */
const digits = () => `9${Array.from(randomBytes(11), (b) => b % 10).join('')}`;

const SECRET = {
  setupToken: fresh(32),
  portalTicket: fresh(),
  bearer: `eyJ${fresh(30)}.${fresh(40)}.${fresh(30)}`,
  adminSession: fresh(),
  portalSession: fresh(),
  refreshToken: `${newUuidV7()}.${fresh()}`,
  code: digits(),
  recoveryCode: `${fresh(4)}-${fresh(4)}`.toUpperCase(),
  continuation: fresh(32),
  password: `pw-${fresh(12)}`,
  invitationToken: fresh(32),
  enrolmentToken: fresh(32),
  deviceSecret: fresh(32),
  platformKey: fresh(),
  verifyToken: fresh(),
};

/** The WhatsApp webhook's own verify token — what the real route compares the query with. */
const WEBHOOK = { verifyToken: SECRET.verifyToken, appSecret: fresh() };

/** Every secret in a query string, under the names this API — or a careless client — would give it. */
const SECRET_QUERY = new URLSearchParams({
  page: '2',
  t: SECRET.portalTicket,
  token: SECRET.setupToken,
  code: SECRET.code,
  continuation: SECRET.continuation,
  password: SECRET.password,
  refreshToken: SECRET.refreshToken,
  access_token: SECRET.bearer,
  recoveryCode: SECRET.recoveryCode,
  enrolmentToken: SECRET.enrolmentToken,
  'hub.verify_token': SECRET.verifyToken,
}).toString();

/**
 * Credentials under the bracketed names Express's query parser still hands a handler as `t`, `token` or
 * `hub.verify_token` — the portal exchange was sent `?t[]=<ticket>` and logged the ticket in full (review finding R3-3).
 */
const BRACKETED = { listed: fresh(), indexed: fresh(), encoded: fresh(), keyed: fresh(), leading: fresh(), token: fresh(32), verifyToken: fresh() };
const BRACKETED_QUERY =
  `t[]=${BRACKETED.listed}&t[0]=${BRACKETED.indexed}&t%5B1%5D=${BRACKETED.encoded}&t[a]=${BRACKETED.keyed}&[t]=${BRACKETED.leading}` +
  `&token[]=${BRACKETED.token}&hub.verify_token[]=${BRACKETED.verifyToken}&page=2`;

/** Every secret in a body, under the names the DTOs give them. */
const SECRET_BODY = {
  token: SECRET.invitationToken,
  password: SECRET.password,
  confirmPassword: SECRET.password,
  code: SECRET.code,
  recoveryCode: SECRET.recoveryCode,
  refreshToken: SECRET.refreshToken,
  continuation: SECRET.continuation,
  enrolmentToken: SECRET.enrolmentToken,
  deviceCredential: { deviceSecret: SECRET.deviceSecret },
};

/** Every secret a header carries: the bearer token, both session cookies, the provisioning key, and a page's URL. */
const SECRET_HEADERS = {
  Authorization: `Bearer ${SECRET.bearer}`,
  Cookie: `dukan_admin=${SECRET.adminSession}; dukan_portal=${SECRET.portalSession}`,
  'X-Platform-Key': SECRET.platformKey,
  Referer: `https://dukan.example.test/account/trial?t=${SECRET.setupToken}`,
};

class NamedBody {
  @IsString() @MaxLength(40) name: string;
}

/** One route per outcome, each reached with every secret on board. */
@Controller({ path: 'probe', version: '1' })
class OutcomesController {
  @Post('ok')
  @HttpCode(200)
  ok(@Body() _body: Record<string, unknown>) {
    return { ok: true };
  }

  /** As the portal exchange answers a ticket: straight to a clean address. */
  @Post('handoff')
  handoff(@Res() res: Response) {
    res.redirect(302, '/account?welcome=1');
  }

  @Post('validated')
  validated(@Body() body: NamedBody) {
    return body;
  }

  @Post('signed-in')
  signedIn() {
    throw new UnauthorizedException();
  }

  @Post('owner-only')
  ownerOnly() {
    throw new ForbiddenException({ code: 'owner_only', message: 'Only the business owner can do this.' });
  }

  @Post('limited')
  @Throttle({ default: { limit: 1, ttl: 60_000 } })
  @HttpCode(200)
  limited() {
    return { ok: true };
  }

  @Post('broken')
  broken() {
    throw new Error('the handler failed');
  }

  /** A library's error carrying what it was sent — as body-parser attaches the body it refused. */
  @Post('attached')
  attached() {
    throw Object.assign(new Error('a library failed'), {
      status: 500,
      body: `identifier=owner%40shop.test&password=${SECRET.password}`,
      request: { refreshToken: SECRET.refreshToken },
    });
  }
}

describe('the request log never holds a secret, on success or failure (C16)', () => {
  let app: INestApplication;
  const written: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      written.push(chunk.toString('utf8'));
      done();
    },
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true, generateId: true, idGenerator: () => newUuidV7() } }),
        LoggerModule.forRoot({ pinoHttp: [requestLogOptions({ logLevel: 'info', isProduction: true }), sink] }),
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }]),
      ],
      controllers: [OutcomesController, WhatsAppWebhookController],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        {
          provide: AppConfigService,
          useValue: { whatsappWebhookVerifyToken: WEBHOOK.verifyToken, whatsappAppSecret: WEBHOOK.appSecret },
        },
        { provide: PrismaService, useValue: {} },
        { provide: WhatsAppReadiness, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true, rawBody: true });
    app.useLogger(app.get(Logger));
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  /** A POST to `path` with every secret in its query, its headers and its JSON body. */
  const loaded = (path: string) =>
    request(app.getHttpServer()).post(`/api/v1/${path}?${SECRET_QUERY}`).set(SECRET_HEADERS).send(SECRET_BODY);

  /** The lines written, parsed: one JSON object per line. */
  const entries = () => written.map((line) => JSON.parse(line) as Record<string, any>);

  /** The request log's own line about one request to `path`, by the status it ended with and how its query begins. */
  const completed = (path: string, status: number, query = 'page=2&') =>
    entries().filter((entry) => entry.res?.statusCode === status && String(entry.req?.url).startsWith(`/api/v1/${path}?${query}`));

  const statuses: Record<string, number> = {};
  const bracketed: Record<string, number> = {};
  const refused: Record<string, number> = {};
  let webhook: { answered: request.Response; refused: request.Response };

  beforeAll(async () => {
    for (const path of ['probe/ok', 'probe/handoff', 'probe/validated', 'probe/signed-in', 'probe/owner-only', 'probe/nowhere', 'probe/broken']) {
      statuses[path] = (await loaded(path)).status;
    }
    await loaded('probe/limited');
    statuses['probe/limited'] = (await loaded('probe/limited')).status;
    // A body that is not JSON: the parser's own message quotes the first characters it was sent.
    statuses.malformed = (
      await request(app.getHttpServer())
        .post(`/api/v1/probe/ok?${SECRET_QUERY}`)
        .set(SECRET_HEADERS)
        .set('Content-Type', 'application/json')
        .send(`${SECRET.password} ${SECRET.code}`)
    ).status;
    // The real webhook route: the verify token answered (200), and a wrong one refused (403).
    const verify = (token: string) =>
      request(app.getHttpServer())
        .get('/api/v1/messaging/whatsapp/webhook')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '1158201444' })
        .set(SECRET_HEADERS);
    webhook = { answered: await verify(SECRET.verifyToken), refused: await verify(`${SECRET.verifyToken}x`) };
    // The bracketed names: a request line on its own (200), the filter's path (401, 500) and Nest's 404 message.
    for (const path of ['probe/ok', 'probe/signed-in', 'probe/nowhere', 'probe/broken']) {
      bracketed[path] = (await request(app.getHttpServer()).post(`/api/v1/${path}?${BRACKETED_QUERY}`)).status;
    }
    // Bodies the parser refuses, each with a password on board: body-parser attaches the whole body to its error.
    const form = (body: string) =>
      request(app.getHttpServer()).post('/api/v1/probe/ok').set('Content-Type', 'application/x-www-form-urlencoded').send(body);
    const login = `identifier=owner%40shop.test&password=${SECRET.password}`;
    refused.deep = (await form(`${login}&x${'[a]'.repeat(33)}=1`)).status;
    refused.many = (await form(`${login}&${Array.from({ length: 1001 }, (_, i) => `p${i}=1`).join('&')}`)).status;
    refused.large = (await request(app.getHttpServer()).post('/api/v1/probe/ok').send({ password: SECRET.password, note: 'x'.repeat(110_000) })).status;
    refused.attached = (await request(app.getHttpServer()).post('/api/v1/probe/attached')).status;
  });

  it('2xx, 3xx, 400, 401, 403, 404, 429 and 500 — with every secret on board, no line holds any of them', () => {
    expect(statuses).toEqual({
      'probe/ok': 200,
      'probe/handoff': 302,
      'probe/validated': 400,
      'probe/signed-in': 401,
      'probe/owner-only': 403,
      'probe/nowhere': 404,
      'probe/broken': 500,
      'probe/limited': 429,
      malformed: 400,
    });
    expect([webhook.answered.status, webhook.answered.text, webhook.refused.status]).toEqual([200, '1158201444', 403]);

    const log = written.join('\n');
    expect(written.length).toBeGreaterThan(20);
    for (const [name, value] of Object.entries(SECRET)) {
      expect({ name, logged: log.includes(value) }).toEqual({ name, logged: false });
    }
  });

  it('and each line still says what happened: the method, the path with the secret replaced, the status', () => {
    const scrubbedQuery = new RegExp(
      `^\\?page=2&t=\\[redacted\\]&token=\\[redacted\\]&code=\\[redacted\\]&continuation=\\[redacted\\]&password=\\[redacted\\]` +
        `&refreshToken=\\[redacted\\]&access_token=\\[redacted\\]&recoveryCode=\\[redacted\\]&enrolmentToken=\\[redacted\\]` +
        `&hub.verify_token=\\[redacted\\]$`,
    );
    for (const [path, status] of [
      ['probe/ok', 200],
      ['probe/handoff', 302],
      ['probe/validated', 400],
      ['probe/signed-in', 401],
      ['probe/owner-only', 403],
      ['probe/nowhere', 404],
      ['probe/limited', 429],
      ['probe/broken', 500],
    ] as const) {
      const lines = completed(path, status);
      expect({ path, lines: lines.length }).toEqual({ path, lines: 1 });
      const [line] = lines;
      expect(line.req.method).toBe('POST');
      expect(line.req.url.slice(`/api/v1/${path}`.length)).toMatch(scrubbedQuery);
      expect(line.req.query).toMatchObject({ page: '2', t: '[redacted]', token: '[redacted]', 'hub.verify_token': '[redacted]' });
      // The credentials in the headers are gone; the rest of the request is still described.
      expect(line.req.headers).not.toHaveProperty('authorization');
      expect(line.req.headers).not.toHaveProperty('cookie');
      expect(line.req.headers).not.toHaveProperty('x-platform-key');
      expect(line.req.headers.referer).toBe('https://dukan.example.test/account/trial?t=[redacted]');
      expect(line.req.headers['content-type']).toBe('application/json');
    }

    // A refused request is also written by the filter: its status, its code, the path as asked — scrubbed.
    const refusals = entries().filter((entry) => entry.statusCode >= 400);
    for (const [path, status] of [
      ['probe/validated', 400],
      ['probe/signed-in', 401],
      ['probe/owner-only', 403],
      ['probe/nowhere', 404],
      ['probe/limited', 429],
      ['probe/broken', 500],
    ] as const) {
      const line = refusals.find((entry) => entry.statusCode === status && String(entry.path).startsWith(`/api/v1/${path}?page=2&`));
      expect({ path, logged: line !== undefined }).toEqual({ path, logged: true });
      expect(line!.path.slice(`/api/v1/${path}`.length)).toMatch(scrubbedQuery);
    }
    const notFound = refusals.find((entry) => entry.statusCode === 404)!;
    expect(notFound.message).toBe(`Cannot POST ${notFound.path}`);
    const ownerOnly = refusals.find((entry) => entry.statusCode === 403 && entry.code === 'owner_only');
    expect(ownerOnly).toBeDefined();
    // The validation refusal names the fields that should not be there, never their values.
    const validation = refusals.find((entry) => entry.statusCode === 400 && Array.isArray(entry.message))!;
    expect(validation.message).toEqual(expect.arrayContaining(['property password should not exist', 'property token should not exist']));
    // A body that is not JSON is described, not quoted.
    expect(refusals.some((entry) => entry.statusCode === 400 && entry.message === 'The request body is not valid JSON.')).toBe(true);
    // The server error keeps its own error for whoever investigates — and nothing of the request but its scrubbed path.
    const failure = refusals.find((entry) => entry.statusCode === 500 && entry.err)!;
    expect(failure.err).toEqual({ type: 'Error', message: 'the handler failed', stack: expect.stringContaining('the handler failed') });
  });

  it('a body the parser refuses is the client’s 400 or 413, and what it attached to its error is never written (C16)', () => {
    // A form nested deeper than the parser reads, more parameters than it takes, a JSON body over its limit: 500 before.
    expect(refused).toEqual({ deep: 400, many: 413, large: 413, attached: 500 });
    expect(written.join('\n')).not.toContain(SECRET.password);

    // The filter's line for each: the answer given, and no error object at all.
    const answers = entries().filter((entry) => entry.path === '/api/v1/probe/ok' && entry.statusCode >= 400);
    expect(answers.map((entry) => [entry.statusCode, entry.message, entry.err])).toEqual([
      [400, 'The input exceeded the depth', undefined],
      [413, 'too many parameters', undefined],
      [413, 'request entity too large', undefined],
    ]);

    // A server error whose error carries what the request sent: its class, message, stack and status, nothing else.
    const failure = entries().find((entry) => entry.statusCode === 500 && entry.path === '/api/v1/probe/attached')!;
    expect(failure.err).toEqual({ type: 'Error', message: 'a library failed', stack: expect.stringContaining('a library failed'), status: 500 });
    // pino-http's own line about the same request carries an error too, kept by the same rule.
    const requestLine = entries().find((entry) => entry.res?.statusCode === 500 && entry.req?.url === '/api/v1/probe/attached')!;
    expect(Object.keys(requestLine.err).sort()).toEqual(['message', 'stack', 'type']);
  });

  it('a credential under a bracketed name its handler still receives — t[], t[0], t%5B1%5D, t[a], [t] — is scrubbed the same', () => {
    expect(bracketed).toEqual({ 'probe/ok': 200, 'probe/signed-in': 401, 'probe/nowhere': 404, 'probe/broken': 500 });
    const log = written.join('\n');
    for (const [name, value] of Object.entries(BRACKETED)) {
      expect({ name, logged: log.includes(value) }).toEqual({ name, logged: false });
    }

    const scrubbed =
      '?t[]=[redacted]&t[0]=[redacted]&t[1]=[redacted]&t[a]=[redacted]&[t]=[redacted]&token[]=[redacted]' +
      '&hub.verify_token[]=[redacted]&page=2';
    // The request line: the URL with every value replaced, and the parsed query under the names the handler reads.
    for (const [path, status] of Object.entries(bracketed)) {
      const lines = completed(path, status, 't[]=');
      expect({ path, lines: lines.length }).toEqual({ path, lines: 1 });
      expect(lines[0].req.url).toBe(`/api/v1/${path}${scrubbed}`);
      expect(lines[0].req.query).toEqual({ t: '[redacted]', token: '[redacted]', 'hub.verify_token': '[redacted]', page: '2' });
    }
    // The filter's line: the path as asked, scrubbed — and Nest's 404, which repeats the whole URL in its message.
    const refusals = entries().filter((entry) => entry.statusCode >= 400 && String(entry.path).includes('?t[]='));
    expect(refusals.map((entry) => [entry.statusCode, entry.path])).toEqual([
      [401, `/api/v1/probe/signed-in${scrubbed}`],
      [404, `/api/v1/probe/nowhere${scrubbed}`],
      [500, `/api/v1/probe/broken${scrubbed}`],
    ]);
    expect(refusals.find((entry) => entry.statusCode === 404)!.message).toBe(`Cannot POST /api/v1/probe/nowhere${scrubbed}`);
  });
});
