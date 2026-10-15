import type { IncomingMessage } from 'node:http';
import type { Options } from 'pino-http';
import { newUuidV7 } from '../utils/uuid.util';
import { scrubHeaders, scrubQuery, scrubUrl } from './log-scrub';

/**
 * The request log: one structured line per request — method, path, status, timing — with its correlation id, and
 * never a credential (C16).
 *
 * A request carries secrets in three places, and each is kept out of the line differently:
 *
 *  - **headers** — the bearer token, the session cookies and the provisioning key are removed outright
 *    (`redact.paths`), and a `Referer`, being a URL, is scrubbed like one (`scrubHeaders`);
 *  - **the URL** — `redact.paths` cannot reach inside one, and the portal-handoff ticket arrives as `?t=…`, the
 *    webhook's verify token as `?hub.verify_token=…`: the serializer scrubs the URL and the parsed query, so the path
 *    stays followable and the value goes (`scrubUrl`, `scrubQuery`);
 *  - **the body** — never logged: the request serializer carries no body. The body paths below are belt and braces,
 *    for the day somebody adds one. Nor is it logged through an error: a library may hang what it was sent on the
 *    error it throws — body-parser attaches the whole body it refused, a password included — so an error is logged
 *    with its class, message, stack and status, and nothing else (`loggedError`).
 *
 * The exception filter writes its own line for a refused request, and scrubs it by the same rules.
 */
export function requestLogOptions(cfg: { logLevel: string; isProduction: boolean }): Options {
  return {
    level: cfg.logLevel,
    genReqId: (req: IncomingMessage) => (req.headers['x-request-id'] as string | undefined) ?? newUuidV7(),
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        // The provisioning surface's static key (development and staging tooling only — production refuses the route).
        'req.headers["x-platform-key"]',
        'req.body.password',
        'req.body.pin',
        'req.body.refreshToken',
        // Device identity (F1 Stage 3): the enrollment secret the client
        // presents at login. Redacted for parity with the password, so a
        // future body log cannot leak it while the password stays safe.
        'req.body.deviceCredential.deviceSecret',
        // Administrator MFA (0094): the code, a recovery code, the enrolment token, the step-up's password.
        'req.body.code',
        'req.body.recoveryCode',
        'req.body.enrolmentToken',
        'req.body.confirmPassword',
        'res.headers["set-cookie"]',
      ],
      remove: true,
    },
    serializers: {
      req(req: Record<string, unknown>) {
        return { ...req, url: scrubUrl(req.url), query: scrubQuery(req.query), headers: scrubHeaders(req.headers) };
      },
      err: loggedError,
    },
    transport: cfg.isProduction ? undefined : { target: 'pino-pretty', options: { singleLine: true } },
    autoLogging: true,
  };
}

/**
 * An error as the log keeps it — every `err` written, the exception filter's and pino-http's own (C16). It arrives
 * already serialized by pino: `type`, `message` and `stack` (with their causes), then every other field the error
 * carries. Only what a diagnosis needs is kept, and the HTTP status when it has one; anything else is dropped, since
 * that is where a library puts what the request sent it (body-parser's `body`).
 */
function loggedError(err: unknown): unknown {
  if (!err || typeof err !== 'object') return err;
  const { type, message, stack, status, statusCode } = err as Record<string, unknown>;
  const http = status ?? statusCode;
  return { type, message, stack, ...(typeof http === 'number' ? { status: http } : {}) };
}
