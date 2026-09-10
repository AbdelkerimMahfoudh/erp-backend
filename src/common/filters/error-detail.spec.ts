import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
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

  it('still reveals nothing about an unexpected error', () => {
    const body = runFilter(new Error('connect ECONNREFUSED 127.0.0.1:3306'));
    expect(body.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|3306/);
  });
});
