/**
 * Credentials that travel as query parameters, removed before a request line is
 * written to a log.
 *
 * `redact.paths` cannot reach inside a URL. It covers `req.headers.cookie` and
 * `req.body.password`, so the two obvious credentials never reach a log file —
 * but the portal-handoff ticket arrives as `?t=…` on the exchange URL, and
 * `autoLogging` writes that URL twice per request, verbatim.
 *
 * That matters even though the ticket is single-use and lives ninety seconds.
 * An UNSPENT one is a working credential until it expires, and the rule is
 * already written down in `scripts/staging-verification-code.ts`: a code in a
 * log file is a working credential sitting in a file that gets copied around.
 * Found live during the CP8 staging acceptance, where the ticket appeared
 * twelve times in one run's log.
 *
 * The path is kept and the value replaced, so the request is still followable.
 */
const SECRET_QUERY_KEYS = new Set([
  't',
  'token',
  'code',
  'continuation',
  'secret',
  /*
   * The WhatsApp webhook's verification (`GET messaging/whatsapp/webhook`): Meta presents the verify token both sides
   * configured, as `hub.verify_token`. It is a shared secret, and the request that carries it is a successful one —
   * logged on every subscription check (C16).
   */
  'hub.verify_token',
  /*
   * The credentials this API takes in a body, should a client ever send one in a URL instead: the URL is the one part
   * of a request every log line carries (C16).
   */
  'password',
  'confirmpassword',
  'currentpassword',
  'refreshtoken',
  'access_token',
  'recoverycode',
  'enrolmenttoken',
  'devicesecret',
  'pin',
  /*
   * And what a person searched for (privacy correction, 2026-10-12): a customer's name or number typed into
   * `customers?search=`, a business into `businesses?q=`, a contact into `connections?q=`. A log file outlives
   * the deletion of the person searched for, and nobody de-identifies a log line.
   */
  'search',
  'q',
  'query',
  'phone',
  'email',
  'number',
]);

export const REDACTED = '[redacted]';

/** `/x?t=abc&page=2` → `/x?t=[redacted]&page=2`. Untouched when there is nothing to hide. */
export function scrubUrl(url: string): string;
export function scrubUrl(url: unknown): unknown;
export function scrubUrl(url: unknown): unknown {
  if (typeof url !== 'string') return url;
  const q = url.indexOf('?');
  if (q === -1) return url;

  const params = new URLSearchParams(url.slice(q + 1));
  let touched = false;
  for (const key of [...params.keys()]) {
    if (SECRET_QUERY_KEYS.has(key.toLowerCase())) {
      params.set(key, REDACTED);
      touched = true;
    }
  }
  return touched ? `${url.slice(0, q)}?${decodeURIComponent(params.toString())}` : url;
}

/** The same rule for an already-parsed query object. */
export function scrubQuery(query: unknown): unknown {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return query;

  const entries = Object.entries(query as Record<string, unknown>);
  if (!entries.some(([k]) => SECRET_QUERY_KEYS.has(k.toLowerCase()))) return query;

  return Object.fromEntries(
    entries.map(([k, v]) => [k, SECRET_QUERY_KEYS.has(k.toLowerCase()) ? REDACTED : v]),
  );
}

/**
 * Request headers as a log line keeps them. The credentials among them — the bearer token, the cookies, the
 * provisioning key — are removed by the request log's `redact.paths`; a `Referer` is a URL, the page the browser came
 * from with whatever its query held (a setup link's token on a page that has not cleared it yet), so it is scrubbed
 * like the request's own.
 */
export function scrubHeaders(headers: unknown): unknown {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return headers;
  const { referer } = headers as Record<string, unknown>;
  if (referer === undefined) return headers;
  return { ...(headers as Record<string, unknown>), referer: scrubUrl(referer) };
}
