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
const SECRET_QUERY_KEYS = new Set(['t', 'token', 'code', 'continuation', 'secret']);

export const REDACTED = '[redacted]';

/** `/x?t=abc&page=2` → `/x?t=[redacted]&page=2`. Untouched when there is nothing to hide. */
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
