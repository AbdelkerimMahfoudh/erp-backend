/**
 * Whether the seed may create demo data (docs/48 risk R7).
 *
 * It was opt-out (`SEED_DEMO != "false"`), which meant a seed run on a host
 * where nobody had thought about the variable created a demo company and a
 * demo Owner whose password came from an environment file. Now nothing is
 * seeded unless `SEED_DEMO=true` is said explicitly, and a production runtime
 * refuses even then. Staging (`APP_ENV=staging`, which runs with
 * `NODE_ENV=production`) may still opt in.
 */
export function demoSeedAllowed(
  env: NodeJS.ProcessEnv = process.env,
): 'yes' | 'not_requested' | 'refused_production' {
  const appEnv = (env.APP_ENV ?? '').toLowerCase();
  const production = appEnv === 'production' || (appEnv !== 'staging' && (env.NODE_ENV ?? '').toLowerCase() === 'production');
  if (production) return 'refused_production';
  return env.SEED_DEMO === 'true' ? 'yes' : 'not_requested';
}
