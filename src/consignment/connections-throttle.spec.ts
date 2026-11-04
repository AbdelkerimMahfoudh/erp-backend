import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A code finds a store without opting into search (post-Build-4), so the lookup and the request are paced. */
describe('partner-code lookups and requests are rate-limited', () => {
  const src = readFileSync(join(__dirname, 'connections.controller.ts'), 'utf8');
  it.each(["@Get('stores/lookup')", "@Post('connections')"])('%s carries the code throttle', (route) => {
    const at = src.indexOf(route);
    expect(at).toBeGreaterThan(0);
    expect(src.slice(Math.max(0, at - 80), at)).toContain('@Throttle(CODE_THROTTLE)');
  });
  it('the pace is 20 a minute', () => expect(src).toMatch(/CODE_THROTTLE = \{ default: \{ limit: 20, ttl: 60_000 \} \}/));
  it('name search still needs the store to opt in', () => {
    const service = readFileSync(join(__dirname, 'connections.service.ts'), 'utf8');
    expect(service.slice(service.indexOf('async search'), service.indexOf('async lookup'))).toContain('isDiscoverable: true');
    expect(service.slice(service.indexOf('async lookup'), service.indexOf('async request'))).not.toContain('isDiscoverable: true');
  });
});
