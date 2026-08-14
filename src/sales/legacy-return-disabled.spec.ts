import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GoneException } from '@nestjs/common';
import { SalesController } from './sales.controller';

/**
 * The legacy return endpoint is disabled (I1).
 *
 * What it used to do was unsafe in five separate ways — it trusted a
 * client-supplied refund amount, rewrote the ORIGINAL sale's totals in place,
 * ignored the shop's return policy, restocked a defective phone as sellable by
 * default, and had no request, review, idempotency or concurrency protection.
 * The audit is `docs/27`.
 *
 * These tests prove the dangerous path is **unreachable**, not merely unused.
 * The strongest way to prove "no mutation" is that there is no longer any code
 * that could mutate: the service method and its DTO are gone, so the assertions
 * below read the source rather than mocking a database and hoping the mock was
 * asked the right questions.
 */

const SRC = join(__dirname);
const controller = readFileSync(join(SRC, 'sales.controller.ts'), 'utf8');
const service = readFileSync(join(SRC, 'sales.service.ts'), 'utf8');

/**
 * Assertions of the form "this code no longer exists" must read CODE, not
 * prose. The comments left behind deliberately describe what was removed —
 * "restocked a defective phone", "a client-supplied refund amount" — so a naive
 * substring search finds the explanation and reports the very danger it is
 * documenting. Stripping comments first is what makes the assertion mean what
 * it says.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const controllerCode = stripComments(controller);
const serviceCode = stripComments(service);

describe('the route answers 410 and writes nothing', () => {
  it('throws GoneException with a stable machine-readable code', () => {
    const c = new SalesController({} as never);
    expect(() => c.legacyReturnDisabled()).toThrow(GoneException);
    try {
      c.legacyReturnDisabled();
    } catch (e) {
      const body = (e as GoneException).getResponse() as { code: string; message: string };
      expect(body.code).toBe('legacy_return_disabled');
      // A stale client must learn WHY, not just that something is missing.
      expect(body.message).toMatch(/disabled/i);
      expect((e as GoneException).getStatus()).toBe(410);
    }
  });

  /**
   * The controller is constructed with `{}` as its service above — deliberately.
   * If the handler touched the service at all, that call would throw a
   * TypeError instead of a GoneException, and the test above would fail.
   */
  it('does not reach the sales service at all', () => {
    const c = new SalesController({} as never);
    expect(() => c.legacyReturnDisabled()).toThrow(GoneException);
  });

  it('is not guarded on `sale.return`, because it guards no behaviour', () => {
    const handler = controller.slice(controller.indexOf('legacyReturnDisabled') - 700);
    expect(handler).not.toContain("@RequirePermissions('sale.return')");
  });
});

describe('the unsafe implementation is gone, not commented out', () => {
  it('the service has no returnUnit method', () => {
    expect(serviceCode).not.toMatch(/async\s+returnUnit\s*\(/);
  });

  it('the ReturnSaleDto no longer exists', () => {
    expect(() => readFileSync(join(SRC, 'dto', 'return-sale.dto.ts'), 'utf8')).toThrow();
    expect(controllerCode).not.toContain('ReturnSaleDto');
    expect(serviceCode).not.toContain('ReturnSaleDto');
  });

  /**
   * Each of these is one of the five specific dangers. Asserting on the source
   * is the point: a mocked call count could pass while the code still existed
   * behind a flag.
   */
  it('no client-controlled refund path remains reachable', () => {
    expect(serviceCode).not.toContain('refundAmount');
    expect(controllerCode).not.toContain('refundAmount');
  });

  it('nothing voids a sale line any more', () => {
    expect(serviceCode).not.toMatch(/voided:\s*true/);
  });

  it('nothing rewrites a sale total, cost or margin after the fact', () => {
    // `sale.update` on totals was the historical-rewrite defect.
    expect(serviceCode).not.toMatch(/tx\.sale\.update\([\s\S]{0,400}totalCost/);
    expect(serviceCode).not.toMatch(/isReversed:\s*remaining/);
  });

  it('nothing restocks a returned unit', () => {
    expect(serviceCode).not.toMatch(/dateSold:\s*null/);
    expect(serviceCode).not.toMatch(/\brestock/i);
  });

  it('nothing creates a Return row', () => {
    expect(serviceCode).not.toMatch(/tx\.return\.create/);
  });

  it('leaves a comment saying where the behaviour went', () => {
    // So the next reader does not conclude the feature was lost by accident.
    expect(service).toMatch(/returnUnit[\s\S]*removed in I1/);
  });
});
