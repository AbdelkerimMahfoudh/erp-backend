import { isProductionRuntime } from './provisioning.controller';
import { demoSeedAllowed } from '../../prisma/lib/demo-seed-policy';

/**
 * Two doors that used to be open by default (docs/48 risks R5 and R7).
 */
describe('the legacy provisioning route is closed in production', () => {
  it('by APP_ENV or by NODE_ENV', () => {
    expect(isProductionRuntime({ APP_ENV: 'production' })).toBe(true);
    expect(isProductionRuntime({ NODE_ENV: 'production' })).toBe(true);
    expect(isProductionRuntime({ APP_ENV: 'Production', NODE_ENV: 'development' })).toBe(true);
  });

  it('but staging, which runs with NODE_ENV=production, keeps it for its tooling', () => {
    expect(isProductionRuntime({ APP_ENV: 'staging', NODE_ENV: 'production' })).toBe(false);
    expect(isProductionRuntime({ NODE_ENV: 'development' })).toBe(false);
    expect(isProductionRuntime({})).toBe(false);
  });
});

describe('demo data is opt-in', () => {
  it('only the literal "true" seeds it', () => {
    expect(demoSeedAllowed({ NODE_ENV: 'development' })).toBe('not_requested');
    expect(demoSeedAllowed({ NODE_ENV: 'development', SEED_DEMO: '1' })).toBe('not_requested');
    expect(demoSeedAllowed({ NODE_ENV: 'development', SEED_DEMO: 'yes' })).toBe('not_requested');
    expect(demoSeedAllowed({ NODE_ENV: 'development', SEED_DEMO: 'true' })).toBe('yes');
  });

  it('and production refuses even then', () => {
    expect(demoSeedAllowed({ NODE_ENV: 'production', SEED_DEMO: 'true' })).toBe('refused_production');
    expect(demoSeedAllowed({ APP_ENV: 'production', NODE_ENV: 'development', SEED_DEMO: 'true' })).toBe('refused_production');
    expect(demoSeedAllowed({ APP_ENV: 'staging', NODE_ENV: 'production', SEED_DEMO: 'true' })).toBe('yes');
  });
});
