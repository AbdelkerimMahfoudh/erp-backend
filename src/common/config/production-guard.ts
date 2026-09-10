import { isIngressMode, isLoopbackAddress } from './ingress';

/**
 * What production may not start with.
 *
 * Every setting here already has a documented correct value, and every one of
 * them is a **fail-open default**: get it wrong and the application starts
 * happily and is quietly less safe than the documentation says it is. That is
 * the failure mode worth spending a startup crash on — a refusal to boot is
 * seen within seconds, and a session cookie travelling in clear text is not
 * seen at all.
 *
 * Nothing here is a new policy. Each rule is the one already written down:
 *
 * - `cookieSecure()` in `common/http/cookies.ts` says production must leave
 *   `COOKIE_SECURE` unset or `true`, "or session cookies travel in clear text".
 * - `main.ts` says a deployed environment must set `API_BIND=127.0.0.1` and sit
 *   behind the edge, or the administration ENDPOINTS stay reachable beside the
 *   proxy that enforces the `/admin` boundary — "the guard would then be a
 *   password alone, which is exactly the single layer the deployment is
 *   supposed to avoid while administrator MFA does not exist". That is a
 *   statement about REACHABILITY, not about a bind address — see below.
 * - `ingress.ts` says how the API port is kept private, and why that is
 *   DECLARED rather than detected. Both deployment shapes are supported.
 * - `MessagingModule` already refuses `development-log` in production. This
 *   adds nothing there; it is listed so the whole set is in one place.
 *
 * The check is deliberately NOT part of the Joi schema. Joi validates the shape
 * of one variable at a time; these are relationships between variables and the
 * environment, and expressing them as `when(...)` chains would scatter one
 * argument across six declarations.
 */

export interface ProductionGuardEnv {
  NODE_ENV?: string;
  API_INGRESS?: string;
  COOKIE_SECURE?: string;
  SWAGGER_ENABLED?: string;
  API_BIND?: string;
  CORS_ORIGINS?: string;
  JWT_ACCESS_SECRET?: string;
  APP_DATABASE_URL?: string;
}

/** A `.env` value that means "yes", matching `cookieSecure()`. */
const truthy = (v: string | undefined): boolean => {
  const s = v?.trim().toLowerCase();
  return s === 'true' || s === '1';
};
const falsy = (v: string | undefined): boolean => {
  const s = v?.trim().toLowerCase();
  return s === 'false' || s === '0';
};

/**
 * Every reason this environment must not run as production.
 *
 * Returns the empty array outside production: these are deployment rules, and
 * applying them to a developer's machine would break the LAN testing the
 * project depends on — a phone on the same Wi-Fi has to reach `0.0.0.0`, and
 * `docs/39` keeps a plain-HTTP LAN path open on purpose.
 */
export function productionConfigProblems(env: ProductionGuardEnv): string[] {
  if (env.NODE_ENV !== 'production') return [];

  const problems: string[] = [];

  // A Secure cookie is discarded by a browser on plain HTTP, so turning this
  // off is how a session cookie ends up travelling in clear text.
  if (falsy(env.COOKIE_SECURE)) {
    problems.push(
      'COOKIE_SECURE is false. In production this puts session cookies in clear text. ' +
        'Leave it unset, or set it to true.',
    );
  }

  // The API surface, published. Not a vulnerability by itself, and a map of
  // every route and payload shape handed to anyone who asks.
  if (truthy(env.SWAGGER_ENABLED)) {
    problems.push(
      'SWAGGER_ENABLED is true. Production must not publish the API documentation. ' +
        'Set SWAGGER_ENABLED=false.',
    );
  }

  /*
   * How the API port is kept private — declared, not guessed.
   *
   * An earlier version of this guard rejected 0.0.0.0 outright. That was
   * wrong: it encoded ONE of the two correct implementations as if it were the
   * invariant, and it would have refused to start this project's own staging
   * stack, whose compose file says in as many words not to bind loopback
   * inside a container. See `ingress.ts` for the invariant that actually
   * holds. Both modes are equally supported and neither is recommended here.
   */
  if (!isIngressMode(env.API_INGRESS)) {
    problems.push(
      'API_INGRESS is not set. Production must declare how the API port is kept ' +
        'private: "loopback" (the API binds 127.0.0.1 on a host it shares with the ' +
        'edge) or "network" (the API is on a private network or container and the ' +
        'edge is the only thing that can reach it). Both are supported.',
    );
  } else if (env.API_INGRESS === 'loopback' && !isLoopbackAddress(env.API_BIND)) {
    problems.push(
      `API_INGRESS=loopback but API_BIND is ${env.API_BIND ?? 'unset (defaults to 0.0.0.0)'}. ` +
        'On a shared host the bind address IS the isolation, so /api/* would be ' +
        'reachable without the proxy that enforces the /admin boundary. ' +
        'Set API_BIND=127.0.0.1, or declare API_INGRESS=network if the network ' +
        'already isolates the port.',
    );
  }

  /*
   * An empty CORS list is FAIL-CLOSED — `main.ts` turns it into `origin: false`
   * — so it is allowed here. What is not allowed is a production origin list
   * that still names a development host: that is a copied `.env`, and it grants
   * a real browser on a developer's machine a credentialed cross-origin path
   * into production data.
   */
  const devOrigins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => /localhost|127\.0\.0\.1|\b10\.|\b192\.168\.|\b172\.(1[6-9]|2\d|3[01])\./.test(o));
  if (devOrigins.length > 0) {
    problems.push(
      `CORS_ORIGINS names development hosts in production: ${devOrigins.join(', ')}. ` +
        'This is a copied .env — remove them.',
    );
  }

  // Joi already enforces a 32-character minimum. What it cannot see is that the
  // value is the one committed in `.env.example` for everyone to read.
  if (env.JWT_ACCESS_SECRET && /change|example|secret|placeholder|test/i.test(env.JWT_ACCESS_SECRET)) {
    problems.push(
      'JWT_ACCESS_SECRET looks like a placeholder from an example file. ' +
        'Generate a real one.',
    );
  }

  /*
   * A localhost database URL is NOT checked, deliberately.
   *
   * It was, briefly, on the theory that it looked like a copied development
   * `.env`. That is an assumption about architecture, not an invariant: an
   * application and its MySQL on one VPS connect over loopback, and that is a
   * perfectly ordinary single-host deployment. Refusing it would have been the
   * same mistake as the blanket bind rejection above — encoding one deployment
   * shape as if it were a security property.
   *
   * What actually catches a copied `.env` is the placeholder check above, which
   * tests the VALUE rather than the topology.
   */

  return problems;
}

/**
 * Refuse to start rather than start wrong.
 *
 * Throwing is the point. Every one of these has a silent failure mode, and a
 * process that exits with the reason on stdout is the only version anybody
 * notices.
 */
export function assertProductionConfig(env: ProductionGuardEnv = process.env): void {
  const problems = productionConfigProblems(env);
  if (problems.length === 0) return;

  throw new Error(
    `Refusing to start in production with unsafe configuration:\n` +
      problems.map((p) => `  - ${p}`).join('\n'),
  );
}
