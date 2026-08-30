/**
 * Which environment this process is.
 *
 * Read from `APP_ENV` rather than `NODE_ENV`, because a staging build sets
 * `NODE_ENV=production` deliberately — it is a production-LIKE build, and the
 * two questions are genuinely different. Conflating them is how a staging-only
 * guard silently stops guarding.
 */
export function isStagingEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.APP_ENV ?? '').trim().toLowerCase() === 'staging';
}
