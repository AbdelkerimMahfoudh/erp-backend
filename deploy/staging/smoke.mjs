// Post-deployment smoke test for the staging API (docs/99 §9). Read-only, unauthenticated, dependency-free (Node 22):
//
//   node deploy/staging/smoke.mjs https://staging-api.tsxmr.com [--commit <sha>] [--allowed-origin https://…]
//   node deploy/staging/smoke.mjs https://api.tsxmr.com --environment production --expect-hsts      (production, docs/100)
//   deploy/staging/smoke.sh                 (from the host, with the stack's own values)
//
// It never signs in, writes nothing and needs no secret. It proves what a deployment must prove before anyone tests on
// it: HTTPS and redirect, liveness, readiness with every carried migration applied, the deployed commit, the staging
// identity, the API docs closed, protected routes refusing an anonymous caller, CORS refusing an unknown origin, the
// security headers, rate-limit headers, no stack trace in an error, and the WhatsApp webhook closed to a wrong token
// and an unsigned body. Exit 1 on any failure.
import { connect } from 'node:tls';

const args = process.argv.slice(2);
const origin = (args.find((a) => !a.startsWith('--')) ?? '').replace(/\/+$/, '');
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const expectCommit = opt('--commit');
const allowedOrigin = opt('--allowed-origin');
const insecure = args.includes('--insecure-local'); // the local rehearsal's self-signed edge only; never against a real host
// The environment the deployment must report (staging unless said), and whether the API must send HSTS (production does;
// staging deliberately does not, main.ts).
const environment = opt('--environment') ?? 'staging';
const expectHsts = args.includes('--expect-hsts');
if (!/^https:\/\/[^/]+$/.test(origin)) {
  console.error('Usage: node deploy/staging/smoke.mjs https://<staging API host> [--commit <sha>] [--allowed-origin <https origin>]');
  process.exit(2);
}
if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const host = new URL(origin).hostname;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
async function get(path, init = {}) {
  try {
    const r = await fetch(`${origin}${path}`, { redirect: 'manual', ...init });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: r.status, headers: r.headers, text, json };
  } catch (e) {
    return { status: 0, headers: new Headers(), text: String(e.cause ?? e), json: null };
  }
}

// ── Transport ────────────────────────────────────────────────────────────────────────────────────────────────────────
if (!insecure) {
  const tls = await new Promise((resolve) => {
    const s = connect({ host, port: 443, servername: host, timeout: 15000 }, () => {
      const c = s.getPeerCertificate();
      resolve({ ok: s.authorized, validTo: c.valid_to, names: c.subjectaltname });
      s.end();
    });
    s.on('error', (e) => resolve({ ok: false, error: String(e) }));
    s.on('timeout', () => resolve({ ok: false, error: 'timeout' }));
  });
  const days = tls.validTo ? Math.round((Date.parse(tls.validTo) - Date.now()) / 86400000) : -1;
  check('TLS certificate valid for the host', tls.ok && String(tls.names).includes(host) && days > 7, `${days} days left`);
  try {
    const r = await fetch(`http://${host}/api/health`, { redirect: 'manual' });
    check('http:// redirects to https://', [301, 308].includes(r.status) && (r.headers.get('location') ?? '').startsWith(`https://${host}/`), `${r.status}`);
  } catch (e) {
    check('http:// redirects to https://', false, String(e.cause ?? e));
  }
}

// ── Health, readiness, identity ──────────────────────────────────────────────────────────────────────────────────────
const live = await get('/api/health');
check('liveness /api/health answers 200 with the database up', live.status === 200 && live.json?.status === 'ok', `${live.status}`);
const ready = await get('/api/health/ready');
check(
  'readiness: ready, no unfinished and no missing migration',
  ready.json?.ready === true && ready.json?.pendingMigrations === 0 && ready.json?.migrationsMissing === 0,
  `applied ${ready.json?.migrationsApplied} of ${ready.json?.migrationsInBuild} carried`,
);
check(`readiness reports the ${environment} environment`, ready.json?.environment === environment, `${ready.json?.environment}`);
const version = await get('/api/health/version');
check(
  expectCommit ? `the deployed commit is ${expectCommit.slice(0, 12)}` : 'the deployed commit is stamped',
  version.json && version.json.commit !== 'unknown' && (!expectCommit || version.json.commit === expectCommit),
  `${String(version.json?.commit).slice(0, 12)} built ${version.json?.builtAt}`,
);

// ── Surface ──────────────────────────────────────────────────────────────────────────────────────────────────────────
check('the API documentation is closed (/docs)', (await get('/docs')).status === 404);
const me = await get('/api/v1/auth/me');
check('a protected route refuses an anonymous caller', me.status === 401, `${me.status}`);
const missing = await get('/api/v1/no-such-route-smoke');
check('an error carries no stack trace', missing.status === 404 && !/at .+\(.+:\d+:\d+\)|"stack"/.test(missing.text), `${missing.status}`);
const h = live.headers;
check('security headers: nosniff, frame denial, no X-Powered-By', h.get('x-content-type-options') === 'nosniff' && !!h.get('x-frame-options') && !h.get('x-powered-by'));
if (expectHsts) {
  const hsts = h.get('strict-transport-security') ?? '';
  const maxAge = Number((/max-age=(d+)/.exec(hsts) ?? [])[1] ?? 0);
  check('HSTS is sent, for at least 180 days', maxAge >= 15552000, hsts || 'none');
}
const anyRateHeader = [...me.headers.keys(), ...live.headers.keys()].some((k) => k.startsWith('x-ratelimit') || k === 'retry-after');
check('rate limiting is active (rate-limit headers present)', anyRateHeader);

// ── CORS: an unknown origin gets no grant; an allowed one (if named) gets exactly itself ─────────────────────────────
const pre = (o) => get('/api/v1/auth/login', { method: 'OPTIONS', headers: { Origin: o, 'Access-Control-Request-Method': 'POST' } });
const evil = await pre('https://not-allowed.example');
// An unreachable API grants nothing too: the check needs an answer before the missing header means anything.
check('CORS grants nothing to an unknown origin', evil.status > 0 && !evil.headers.get('access-control-allow-origin'), `${evil.status} ${evil.headers.get('access-control-allow-origin') ?? 'none'}`);
if (allowedOrigin) {
  const good = await pre(allowedOrigin);
  check(`CORS grants exactly ${allowedOrigin}`, good.headers.get('access-control-allow-origin') === allowedOrigin && good.headers.get('access-control-allow-origin') !== '*');
}

// ── The WhatsApp webhook: closed to a wrong verify token and to an unsigned body ─────────────────────────────────────
const verify = await get('/api/v1/messaging/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=smoke-wrong-token&hub.challenge=123');
check('webhook verification refuses a wrong token', [403, 404].includes(verify.status), `${verify.status}${verify.status === 404 ? ' (webhook not configured)' : ''}`);
const unsigned = await get('/api/v1/messaging/whatsapp/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"object":"whatsapp_business_account","entry":[]}' });
check('webhook refuses an unsigned body', [401, 403, 404].includes(unsigned.status), `${unsigned.status}`);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} smoke checks passed against ${origin}`);
process.exit(failed ? 1 : 0);
