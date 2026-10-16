import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { Logger } from 'nestjs-pino';
import { Request, Response } from 'express';
import { AppClsStore } from '../context/request-context';
import { scrubUrl } from '../http/log-scrub';
import { MissingTenantContextError } from '../../prisma/tenant.extension';
import { InvalidUuidError } from '../utils/uuid.util';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  /** Optional machine-readable code (e.g. `device_unrecognized`) for clients to branch on. */
  code?: string;
  /**
   * Per-item detail: which thing could not be moved, and why.
   *
   * Passed through by an explicit allowlist — see `DETAIL_KEYS`.
   */
  problems?: unknown;
  units?: unknown;
  belowCost?: unknown;
  configuredPrice?: unknown;
  lineIndex?: unknown;
  unitId?: unknown;
  identifier?: unknown;
  acknowledgement?: unknown;
  businessDate?: unknown;
  closedReason?: unknown;
  attemptsRemaining?: unknown;
  resendAvailableAt?: unknown;
  delivery?: unknown;
  challengeId?: unknown;
  trackedCash?: unknown;
  missing?: unknown;
  expectedConfigVersionId?: unknown;
  currentConfigVersionId?: unknown;
  providers?: unknown;
  activity?: unknown;
  required?: unknown;
  state?: unknown;
  report?: unknown;
  channels?: unknown;
  floats?: unknown;
  missingContacts?: unknown;
  termsVersion?: unknown;
  trial?: unknown;
  unavailableContacts?: unknown;
  requestId?: string;
  path: string;
  timestamp: string;
}

/**
 * Fields a service may attach to an HttpException and expect to survive.
 *
 * This filter deliberately reshapes every error so nothing leaks, and until
 * H1.4 that meant it kept only `message` and `code` and **silently discarded
 * everything else**. Transfers had been attaching `problems` since H1.1 —
 * "which phone, and why not" — and the mobile app has read `body.problems`
 * since H1.3 to list the refusals item by item. It always got `undefined`, so
 * the user only ever saw the generic sentence, and no test noticed because
 * every one of them asserted the status code.
 *
 * An allowlist rather than a spread: the reason this filter exists is that an
 * exception body may carry internals, and passing whatever a service happened
 * to attach would give that back.
 */
const DETAIL_KEYS = [
  'problems',
  'units',
  /*
   * A2/CP4. `approval_required` has to say WHICH phone and at what set price,
   * or the phone cannot open the right request — and the same failure the
   * comment above describes happened again: the fields were attached, the
   * filter dropped them, and every unit test passed because they all asserted
   * that an exception was thrown rather than what a client receives. The live
   * run is what noticed.
   */
  'belowCost',
  'configuredPrice',
  'lineIndex',
  'unitId',
  'identifier',
  /* Why an acknowledgement was refused. Deliberately not named `reason`: that
   * word is free text on half the mutations in this app, and allowlisting it
   * would pass whatever any of them happened to attach. */
  'acknowledgement',
  /* `store_closed`: which business day is closed, so a screen can name it and offer to open it without reading the sentence. */
  'businessDate',
  /* `store_closed`: a closed day (`closed`) or one nobody opened yet (`not_opened`, docs/63) — the screen offers the
   * reopen or the opening. Its own name, not `reason`, for the reason given above. */
  'closedReason',
  /*
   * Codes and account deletion (docs/64). `invalid_code` says how many attempts
   * are left, `too_many_codes` says when a resend is allowed, and a refused
   * delivery names the failure class (`delivery`) and the challenge it belongs
   * to — none of which is a secret, and all of which the screen needs to say
   * something truer than "try again".
   */
  'attemptsRemaining',
  'resendAvailableAt',
  'delivery',
  'challengeId',
  // The drawer's tracked amount when an opening refuses to keep it (`opening_cash_negative`, 2026-10-08).
  'trackedCash',
  /*
   * The Money Services Agent activity (docs/73, D154–D156, D164). `float_count_required` lists the providers still
   * to count (D164 removed `provider_not_configured` and `stale_configuration`: a provider has nothing to configure
   * before use, and the commission is typed per exchange, so neither version id is sent any more); `activity_not_subscribed` (D156) says
   * what the branch IS subscribed to and what the route needed, so the app can say "this branch does not sell"
   * rather than "forbidden" — a flag, never a price. `permission_denied` (D161) names the keys the caller lacks
   * under the same `missing`.
   */
  'missing',
  'providers',
  'activity',
  'required',
  /*
   * The subscription state behind an entitlement refusal (D161): the write refusal says `expired`, `suspended`,
   * `cancelled`, `pending` or `rejected`, so a phone replaying a queued write knows whether sending it again can
   * ever succeed, and a suspended business is not told its subscription ended. The read refusals attached it all
   * along; this list dropped it.
   */
  'state',
  /*
   * The close refused on figures that moved (D159, docs/73 §11.2): `report_changed` and `money_moved_after_count`
   * carry the report as it stands now — already gated for the caller, section by section — and the latter names the
   * channels and floats to count again, so the phone reloads and opens the count step for exactly those. Before
   * this, `report_changed` attached its report and the filter dropped it.
   */
  'report',
  'channels',
  'floats',
  /*
   * The free trial's claim refusals (0095), each with what the website needs to say something truer than "no":
   * `contact_unverified` names which contacts are still to verify (`email`, `phone` — the kinds, never a value);
   * `terms_changed` carries the terms version now in force; `trial_already_claimed` carries the trial that was
   * started, with its own instants, so the page can show it instead.
   */
  'missingContacts',
  'termsVersion',
  'trial',
  /*
   * `period_ends_before_trial_end` (review finding R4-05): the end of the free trial a period must pass, a UTC ISO
   * instant — so the console says it in the business's zone with the zone's name, and the sentence holds no instant.
   */
  'trialEndsAt',
  /*
   * `registration_unavailable` (C10): which of the contacts given cannot receive a verification code right now
   * (`email`, `phone` — the kinds, never a value), so the form can offer to continue without that one.
   */
  'unavailableContacts',
] as const;

/**
 * A message as the log may keep it. Nest's own 404 names the URL ("Cannot GET /path?query"), so its query is scrubbed
 * as the path's is. A body that is not JSON is described, never quoted: Nest answers it with the parser's message,
 * which carries the first characters of whatever was sent — a password as readily as anything else.
 */
function loggedMessage(message: unknown, status: number, url: string): unknown {
  if (Array.isArray(message)) return message.map((line) => loggedMessage(line, status, url));
  if (typeof message !== 'string') return message;
  if (status === HttpStatus.BAD_REQUEST && /\bJSON\b/.test(message)) return 'The request body is not valid JSON.';
  return url && message.includes(url) ? message.split(url).join(scrubUrl(url)) : message;
}

/** An http-errors error meant for the client — a 4xx whose message may be shown (`expose`): body-parser's refusals. */
function isClientHttpError(exception: unknown): exception is Error & { status: number } {
  if (!(exception instanceof Error)) return false;
  const { status, expose } = exception as Error & { status?: unknown; expose?: unknown };
  return expose === true && typeof status === 'number' && status >= 400 && status < 500;
}

/**
 * Single global exception filter. Produces a consistent error body, maps Prisma
 * and tenant-context errors to appropriate HTTP codes, and NEVER leaks stack
 * traces or SQL to clients. Server-side it logs a 5xx as an error with its
 * class, message and stack (the request log's `loggedError` keeps nothing
 * else), and every other refusal as a warning with the answer given.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    private readonly logger: Logger,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, message, code, details } = this.resolve(exception);

    const body: ErrorBody = {
      statusCode: status,
      error: HttpStatus[status] ?? 'ERROR',
      message,
      ...(code ? { code } : {}),
      ...details,
      requestId: this.cls.getId?.() ?? this.cls.get('requestId'),
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    /*
     * The log keeps the same body minus what a request can smuggle into it (R3-3, C16): a credential in the query —
     * the portal ticket, a setup token, the webhook's verify token — would otherwise be written on every refused
     * request, and Nest's 404 repeats the whole URL in its message. The client is still answered with the path it
     * asked for.
     */
    const logged = {
      ...body,
      path: scrubUrl(request.url),
      message: loggedMessage(message, status, request.originalUrl ?? request.url),
    };
    if (status >= 500) {
      this.logger.error({ err: exception, ...logged }, 'Unhandled server error');
    } else {
      this.logger.warn(logged, 'Request error');
    }

    response.status(status).json(body);
  }

  private resolve(exception: unknown): {
    status: number;
    message: string | string[];
    code?: string;
    details: Record<string, unknown>;
  } {
    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      if (typeof res === 'string') {
        return { status: exception.getStatus(), message: res, details: {} };
      }
      const obj = res as Record<string, unknown> & { message?: string | string[]; code?: string };
      const details: Record<string, unknown> = {};
      for (const key of DETAIL_KEYS) {
        if (obj[key] !== undefined) details[key] = obj[key];
      }
      return {
        status: exception.getStatus(),
        message: obj.message ?? exception.message,
        code: typeof obj.code === 'string' ? obj.code : undefined,
        details,
      };
    }

    if (isClientHttpError(exception)) {
      /*
       * What body-parser refuses before any handler runs — a form nested deeper than it reads, more parameters than
       * it takes, a body over its limit, a charset it does not know: the client's request, answered with the status
       * and the message http-errors marks as safe to show (`expose`), never as a server error. Like every refusal it
       * is logged with the answer only, never with the body the parser attached to it (C16).
       */
      return { status: exception.status, message: exception.message, details: {} };
    }

    if (exception instanceof InvalidUuidError) {
      /*
       * A record id that is not a uuid reached `uuidToBin` (2026-10-16: nine routes, among them GET /categories/:id,
       * PATCH /categories/:id, POST /imports/:id/commit and POST /users/:id/cancel-invitation, answered 500). It is the
       * client's mistake, answered as `RecordIdPipe` answers it (D161): a phone replaying a queued write treats a 5xx
       * as "the outcome is unknown", which for a malformed id it never stops being. Ids read from the database are
       * Buffers and never pass through `uuidToBin`.
       */
      return { status: HttpStatus.BAD_REQUEST, message: 'That record id is not valid.', code: 'id_invalid', details: {} };
    }

    if (exception instanceof MissingTenantContextError) {
      // Internal invariant violation — a tenant query ran without context.
      return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error', details: {} };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return { ...this.mapPrismaError(exception), details: {} };
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return { status: HttpStatus.BAD_REQUEST, message: 'Invalid query parameters', details: {} };
    }

    return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error', details: {} };
  }

  private mapPrismaError(e: Prisma.PrismaClientKnownRequestError): {
    status: number;
    message: string;
  } {
    switch (e.code) {
      case 'P2002':
        return { status: HttpStatus.CONFLICT, message: 'A record with these values already exists' };
      case 'P2025':
        return { status: HttpStatus.NOT_FOUND, message: 'Record not found' };
      case 'P2003':
        return { status: HttpStatus.CONFLICT, message: 'Related record constraint failed' };
      case 'P2000':
        return { status: HttpStatus.BAD_REQUEST, message: 'Value too long for column' };
      default:
        return { status: HttpStatus.BAD_REQUEST, message: 'Database request error' };
    }
  }
}
