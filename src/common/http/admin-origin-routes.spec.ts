import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every route of the console passes the origin rule: it is enforced inside PlatformAdminGuard, so a console route is
 * covered exactly when it names that guard, or AdminOriginGuard before it has a session.
 */
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const controllers = walk(join(process.cwd(), 'src/platform')).filter((f) => f.endsWith('.controller.ts'));

/** A handler's decorators: from the end of the last member up to its method. */
const handlers = (source: string) => source.replace(/\r\n/g, '\n').split(/\n\s*\n/).filter((block) => /@(Get|Post|Put|Patch|Delete)\(/.test(block));

describe('the console routes pass the origin rule', () => {
  it('the routes under platform/admin', () => {
    const open: string[] = [];
    for (const file of controllers) {
      const source = readFileSync(file, 'utf8');
      const whole = /path: 'platform\/admin'/.test(source);
      for (const block of handlers(source)) {
        const route = /@(?:Get|Post|Put|Patch|Delete)\('([^']*)'\)/.exec(block)?.[1] ?? '';
        if ((whole || route.startsWith('admin/')) && !/UseGuards\((?:AdminOriginGuard|PlatformAdminGuard)/.test(block)) open.push(`${file}: ${route}`);
      }
    }
    expect(open).toEqual([]);
  });

  it('the review and recovery of a payment proof', () => {
    const blocks = handlers(readFileSync(join(process.cwd(), 'src/platform/payment-proofs.controller.ts'), 'utf8')).filter((b) => /'payment-proofs/.test(b));
    expect(blocks.length).toBeGreaterThanOrEqual(8);
    for (const block of blocks) expect(block).toMatch(/UseGuards\(PlatformAdminGuard\)/);
  });

  it('the setup and sign-in of an administrator', () => {
    expect(readFileSync(join(process.cwd(), 'src/platform/platform-admin-setup.controller.ts'), 'utf8')).toMatch(/UseGuards\(AdminOriginGuard\)/);
    expect(readFileSync(join(process.cwd(), 'src/platform/platform.controller.ts'), 'utf8')).toMatch(/UseGuards\(AdminOriginGuard\)\s+@Throttle\(PUBLIC_THROTTLE\)\s+@Post\('admin\/sign-in'\)/);
  });
});
