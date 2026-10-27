import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

/**
 * The filter must keep per-item detail, and must keep nothing else.
 *
 * This exists because it did neither for three phases. Transfers attached
 * `problems` from H1.1 and the mobile app read `body.problems` from H1.3, and
 * the filter quietly dropped it — so the app listed nothing and every test
 * stayed green, because they all asserted the status code.
 */

function runFilter(exception: unknown): Record<string, unknown> {
  let captured: Record<string, unknown> = {};
  const response = {
    status: () => response,
    json: (body: Record<string, unknown>) => {
      captured = body;
      return response;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ url: '/api/v1/transfers' }),
    }),
  };
  const logger = { error: () => undefined, warn: () => undefined };
  const cls = { getId: () => 'req-1', get: () => 'req-1' };

  new AllExceptionsFilter(logger as never, cls as never).catch(exception, host as never);
  return captured;
}

describe('per-item detail survives the filter', () => {
  it('keeps `problems` on a duplicate-scan refusal', () => {
    const body = runFilter(
      new BadRequestException({
        message: 'The same item was listed more than once',
        problems: [{ identifier: '356938035643809', reason: 'scanned twice' }],
      }),
    );
    expect(body.problems).toEqual([{ identifier: '356938035643809', reason: 'scanned twice' }]);
    expect(body.message).toBe('The same item was listed more than once');
  });

  it('keeps the availability numbers on an over-request', () => {
    const body = runFilter(
      new ConflictException({
        message: 'There is not enough of that left to transfer',
        problems: [
          {
            productId: 'p1',
            product: 'Anker PowerCore 10000',
            requested: 999,
            physicalQuantity: 50,
            reservedQuantity: 10,
            availableQuantity: 40,
          },
        ],
      }),
    );
    const problem = (body.problems as Record<string, unknown>[])[0];
    expect(problem.requested).toBe(999);
    expect(problem.physicalQuantity).toBe(50);
    expect(problem.reservedQuantity).toBe(10);
    expect(problem.availableQuantity).toBe(40);
  });

  it('keeps `units` on a shipment conflict', () => {
    const body = runFilter(
      new ConflictException({
        message: 'Some units are no longer in stock at this branch',
        units: ['356938035643809'],
      }),
    );
    expect(body.units).toEqual(['356938035643809']);
  });

  it('still refuses to pass anything not on the allowlist', () => {
    const body = runFilter(
      new BadRequestException({
        message: 'nope',
        problems: [{ reason: 'fine' }],
        sql: 'SELECT * FROM users',
        stack: 'at somewhere',
        internalState: { secret: 'value' },
      }),
    );
    expect(body.problems).toBeDefined();
    expect(body).not.toHaveProperty('sql');
    expect(body).not.toHaveProperty('stack');
    expect(body).not.toHaveProperty('internalState');
  });

  it('leaves a plain string exception alone', () => {
    const body = runFilter(new HttpException('Forbidden', HttpStatus.FORBIDDEN));
    expect(body.message).toBe('Forbidden');
    expect(body.statusCode).toBe(HttpStatus.FORBIDDEN);
    expect(body).not.toHaveProperty('problems');
  });

  it('adds no detail key when the service attached none', () => {
    const body = runFilter(new ConflictException({ message: 'plain' }));
    expect(body).not.toHaveProperty('problems');
    expect(body).not.toHaveProperty('units');
  });

  it('carries the fields a price refusal needs to be acted on', () => {
    /*
     * Found live in CP6, and it is the second time this exact failure has
     * happened here — the fields were attached by the service, the filter
     * dropped them, and every unit test passed because they all asserted that
     * an exception was thrown rather than what a client receives.
     *
     * Without these the phone knows only that SOMETHING needs approval, and
     * cannot say which item or at what set price.
     */
    const body = runFilter(
      new ForbiddenException({
        code: 'approval_required',
        message: 'needs approval',
        belowCost: true,
        configuredPrice: 17000,
        lineIndex: 0,
        unitId: '019f0000-0000-7000-8000-000000000001',
        identifier: '359111000000001',
      }),
    );
    expect(body.code).toBe('approval_required');
    expect(body.belowCost).toBe(true);
    expect(body.configuredPrice).toBe(17000);
    expect(body.lineIndex).toBe(0);
    expect(body.unitId).toBe('019f0000-0000-7000-8000-000000000001');
    expect(body.identifier).toBe('359111000000001');
  });

  it('carries why an acknowledgement was refused, under its own name', () => {
    // Deliberately not `reason`: that word is free text on half the mutations
    // in this app, and allowlisting it would pass whatever any of them attached.
    const body = runFilter(
      new ConflictException({
        code: 'acknowledgement_rejected',
        message: 'no',
        acknowledgement: 'bad_signature',
        reason: 'a free-text field that must NOT travel',
      }),
    );
    expect(body.acknowledgement).toBe('bad_signature');
    expect(body).not.toHaveProperty('reason');
  });

  it('says why the store is closed — a closed day, or one nobody opened yet (docs/63)', () => {
    // The unit specs assert the exception; only the filter decides what the phone receives.
    const body = runFilter(
      new ConflictException({ code: 'store_closed', closedReason: 'not_opened', message: 'no', businessDate: '2026-10-01' }),
    );
    expect(body).toMatchObject({ code: 'store_closed', closedReason: 'not_opened', businessDate: '2026-10-01' });
  });

  it('names the product an intake should receive into when it already exists (D223)', () => {
    // Found by the disposable end-to-end run: the service attached the id and the filter dropped it.
    const body = runFilter(
      new ConflictException({ code: 'product_exists', message: 'exists', productId: '018f0000-0000-7000-8000-00000000a001' }),
    );
    expect(body).toMatchObject({ code: 'product_exists', productId: '018f0000-0000-7000-8000-00000000a001' });
  });

  it('says what a branch is subscribed to and what the route needed (D156)', () => {
    // The app says "this branch does not sell" from the two fields, never from the sentence.
    const body = runFilter(
      new ForbiddenException({
        code: 'activity_not_subscribed',
        message: 'no',
        activity: 'money_agent',
        required: 'electronics',
      }),
    );
    expect(body).toMatchObject({ code: 'activity_not_subscribed', activity: 'money_agent', required: 'electronics' });
  });

  it('carries the stable access refusals a replaying phone reads (D161)', () => {
    // A refusal raised before a queued write's key was looked up: the phone decides from the code and these fields.
    expect(
      runFilter(new ForbiddenException({ code: 'permission_denied', message: 'Missing permission(s): agent.transaction.record', missing: ['agent.transaction.record'] })),
    ).toMatchObject({ statusCode: 403, code: 'permission_denied', missing: ['agent.transaction.record'] });
    expect(runFilter(new ForbiddenException({ code: 'branch_access_denied', message: 'No access to the requested branch' }))).toMatchObject({
      statusCode: 403,
      code: 'branch_access_denied',
      message: 'No access to the requested branch',
    });
    expect(runFilter(new ForbiddenException({ code: 'branch_inactive', message: 'closed' }))).toMatchObject({ statusCode: 403, code: 'branch_inactive' });
  });

  it('says which subscription state refused the change, so a suspended business is not told it ended (D161)', () => {
    const body = runFilter(new ForbiddenException({ code: 'ENTITLEMENT_WRITE_BLOCKED', message: 'suspended', state: 'suspended' }));
    expect(body).toMatchObject({ statusCode: 403, code: 'ENTITLEMENT_WRITE_BLOCKED', state: 'suspended' });
    // The read refusals attached it all along, and this filter dropped it.
    expect(runFilter(new ForbiddenException({ code: 'ENTITLEMENT_SUSPENDED', message: 'm', state: 'cancelled' }))).toMatchObject({ state: 'cancelled' });
  });

  it('a close refused on figures that moved carries the report as it stands, and what to count again (D159)', () => {
    // Without these the phone could only say "something changed": it reloads from `report` and opens the count step for exactly these.
    const report = { reportVersion: '0123456789abcdef', expected: { cash: { movedSinceCount: true } } };
    const moved = runFilter(
      new ConflictException({
        code: 'money_moved_after_count',
        message: 'Money moved after counting began.',
        channels: [{ key: 'cash:NONE', label: 'Cash' }],
        floats: [{ providerId: 'p1', label: 'Bankily' }],
        report,
      }),
    );
    expect(moved).toMatchObject({ code: 'money_moved_after_count', channels: [{ key: 'cash:NONE', label: 'Cash' }], floats: [{ providerId: 'p1', label: 'Bankily' }], report });
    expect(runFilter(new ConflictException({ code: 'report_changed', message: 'no', report }))).toMatchObject({ code: 'report_changed', report });
  });

  it('a refused free trial claim says which contacts, which terms, or which trial (0095) — never a contact’s value', () => {
    const view = { status: 'active', durationHours: 168, durationDays: 7, claimedAt: 'c', startedAt: 's', endsAt: 'e', timeZone: 'Africa/Nouakchott' };
    expect(runFilter(new ConflictException({ code: 'contact_unverified', message: 'm', missingContacts: ['phone'] }))).toMatchObject({
      statusCode: 409,
      code: 'contact_unverified',
      missingContacts: ['phone'],
    });
    expect(runFilter(new ConflictException({ code: 'terms_changed', message: 'm', termsVersion: '2026-10-13' }))).toMatchObject({
      termsVersion: '2026-10-13',
    });
    expect(runFilter(new ConflictException({ code: 'trial_already_claimed', message: 'm', trial: view }))).toMatchObject({ trial: view });
  });

  it('a period refused for ending inside the free trial carries the trial’s end as data, never in its sentence (R4-05)', () => {
    const body = runFilter(
      new BadRequestException({
        code: 'period_ends_before_trial_end',
        message: 'The end date must be after the free trial ends.',
        trialEndsAt: '2026-10-21T09:30:00.123Z',
      }),
    );
    expect(body).toMatchObject({
      statusCode: 400,
      code: 'period_ends_before_trial_end',
      message: 'The end date must be after the free trial ends.',
      trialEndsAt: '2026-10-21T09:30:00.123Z',
    });
  });

  it('a registration refused before anything was saved names the contacts that cannot receive a code (C10)', () => {
    const body = runFilter(
      new HttpException({ code: 'registration_unavailable', message: 'm', unavailableContacts: ['phone'] }, HttpStatus.SERVICE_UNAVAILABLE),
    );
    expect(body).toMatchObject({ statusCode: 503, code: 'registration_unavailable', unavailableContacts: ['phone'] });
  });

  it('still reveals nothing about an unexpected error', () => {
    const body = runFilter(new Error('connect ECONNREFUSED 127.0.0.1:3306'));
    expect(body.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|3306/);
  });
});

describe('what the filter writes to the log (R3-3, C16)', () => {
  /** The filter on one request: what the client is answered, and every line it logged. */
  function logged(exception: unknown, url: string): { body: Record<string, unknown>; lines: string; calls: unknown[][] } {
    let body: Record<string, unknown> = {};
    const lines: unknown[][] = [];
    const response = {
      status: () => response,
      json: (b: Record<string, unknown>) => {
        body = b;
        return response;
      },
    };
    const host = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ url, originalUrl: url }) }) };
    const logger = { error: (...args: unknown[]) => lines.push(args), warn: (...args: unknown[]) => lines.push(args) };
    new AllExceptionsFilter(logger as never, { getId: () => 'req-1', get: () => 'req-1' } as never).catch(exception, host as never);
    return { body, lines: JSON.stringify(lines), calls: lines };
  }

  // Made at run time, as a setup link's token is: a literal here would be a secret-looking string in the repository.
  const TOKEN = randomBytes(32).toString('base64url');

  it.each([
    ['a setup token in ?t=', `/api/v1/platform/my-subscription/trial/link?t=${TOKEN}`],
    ['a token in ?token=', `/api/v1/platform/owner-invitation/accept?token=${TOKEN}&lang=fr`],
    ['the webhook verify token', `/api/v1/messaging/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${TOKEN}`],
  ])('%s: the logged path keeps the route and drops the value; the client gets the path it asked for', (_name, url) => {
    for (const exception of [new UnauthorizedException(), new ForbiddenException(), new HttpException('slow down', 429)]) {
      const { body, lines } = logged(exception, url);
      expect(lines).not.toContain(TOKEN);
      expect(lines).toContain(url.slice(0, url.indexOf('?')));
      expect(lines).toContain('[redacted]');
      expect(body.path).toBe(url);
    }
  });

  it('Nest’s own 404 names the URL in its message: the query in it is scrubbed too', () => {
    const url = `/api/v1/platform/my-subscription/trial/link?t=${TOKEN}`;
    const { lines, body } = logged(new NotFoundException(`Cannot GET ${url}`), url);
    expect(lines).not.toContain(TOKEN);
    expect(lines).toContain('Cannot GET /api/v1/platform/my-subscription/trial/link?t=[redacted]');
    expect(body.message).toBe(`Cannot GET ${url}`);
  });

  it('a server error is logged with its own error and the scrubbed path', () => {
    const failure = new Error('the database went away');
    const { lines, calls } = logged(failure, `/api/v1/platform/portal-session?t=${TOKEN}`);
    expect(lines).not.toContain(TOKEN);
    expect(calls).toEqual([[expect.objectContaining({ err: failure, path: '/api/v1/platform/portal-session?t=[redacted]' }), 'Unhandled server error']]);
  });

  it('a body that is not JSON is described in the log, never quoted — the parser’s message carries what was sent', () => {
    // How Nest answers body-parser's SyntaxError: a 400 with the parser's message.
    const parserMessage = `Unexpected token 'h', "hunter2-password" is not valid JSON`;
    const { lines, body } = logged(new BadRequestException(parserMessage), '/api/v1/auth/login');
    expect(lines).not.toContain('hunter2');
    expect(lines).toContain('The request body is not valid JSON.');
    expect(body.message).toBe(parserMessage);
  });

  it('a body the parser refuses is the client’s: its own status and message — and the body it attached is never logged', () => {
    // As http-errors builds body-parser's refusals: a 4xx marked safe to show, with the whole body it refused attached.
    const refused = (status: number, message: string, type: string) =>
      Object.assign(new Error(message), { status, statusCode: status, expose: true, type, body: `identifier=owner&password=${TOKEN}` });
    for (const [status, message, type] of [
      [400, 'The input exceeded the depth', 'querystring.parse.rangeError'],
      [413, 'too many parameters', 'parameters.too.many'],
      [413, 'request entity too large', 'entity.too.large'],
      [415, 'unsupported charset "X-UNKNOWN"', 'charset.unsupported'],
    ] as const) {
      const { body, lines, calls } = logged(refused(status, message, type), '/api/v1/auth/login');
      expect(body).toMatchObject({ statusCode: status, message, path: '/api/v1/auth/login' });
      expect(lines).not.toContain(TOKEN);
      expect(calls).toEqual([[expect.objectContaining({ statusCode: status, message }), 'Request error']]);
      expect(calls[0][0]).not.toHaveProperty('err');
    }
  });

  it('only a 4xx marked safe to show is the client’s: anything else is still a server error, said as nothing more', () => {
    for (const exception of [
      Object.assign(new Error('stream is not readable'), { status: 500, statusCode: 500, expose: false }),
      Object.assign(new Error('a 400 nobody marked safe to show'), { status: 400 }),
      Object.assign(new Error('a 503 marked safe to show'), { status: 503, expose: true }),
      { status: 400, expose: true, message: 'not an error at all' },
    ]) {
      expect(runFilter(exception)).toMatchObject({ statusCode: 500, message: 'Internal server error' });
    }
  });

  it('every other message is logged as it was', () => {
    const { lines } = logged(new BadRequestException(['name must be a string', 'property password should not exist']), '/api/v1/x');
    expect(lines).toContain('name must be a string');
    expect(lines).toContain('property password should not exist');
  });
});
