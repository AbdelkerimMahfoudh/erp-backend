// The production stack's contract (docs/100 §8), checked on the RESOLVED compose configuration — what Docker will
// actually run, after every variable and env file is applied:
//
//   docker compose -p <project> --env-file stack.env -f deploy/docker-compose.production.yml --profile tools --profile proof \
//     config --format json | node deploy/production/check-stack.mjs --profile production|rehearsal
//
// deploy.sh runs it before every start; CI runs it on every push. It prints rule names only — never a value, because
// the resolved configuration carries the env files' contents. Exit 1 on any breach.
const args = process.argv.slice(2);
const profile = args[args.indexOf('--profile') + 1];
if (!['production', 'rehearsal'].includes(profile)) {
  console.error('Usage: … | node deploy/production/check-stack.mjs --profile production|rehearsal');
  process.exit(2);
}
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const failures = [];
  const check = (ok, rule) => (ok ? null : failures.push(rule));
  let config;
  try {
    config = JSON.parse(input);
  } catch {
    console.error('check-stack: the input is not the JSON of `docker compose config --format json`.');
    process.exit(2);
  }
  const services = config.services ?? {};
  const s = (name) => services[name] ?? {};

  // ── Exposure: the edge is the only service with a published port ───────────────────────────────────────────────────
  for (const [name, service] of Object.entries(services)) {
    if (name !== 'edge') check(!(service.ports ?? []).length, `${name} publishes no port (only the edge does)`);
  }
  const edgePorts = s('edge').ports ?? [];
  check(edgePorts.length === 2, 'the edge publishes exactly two ports (HTTP and HTTPS)');
  check(
    edgePorts.map((p) => Number(p.target)).sort().join() === '443,80',
    'the edge publishes container ports 80 and 443',
  );
  for (const p of edgePorts) {
    check((p.protocol ?? 'tcp') === 'tcp', 'the edge publishes TCP only (the cloud firewall admits no UDP)');
    if (profile === 'production') {
      check(!p.host_ip || p.host_ip === '0.0.0.0', 'production publishes the edge on every address');
      check(String(p.published) === String(p.target), 'production publishes the edge on 80 and 443 themselves');
    } else {
      check(p.host_ip === '127.0.0.1', 'a rehearsal publishes the edge on 127.0.0.1 only');
    }
  }
  check((s('api').expose ?? []).map(String).join() === '3010', 'the API listens on 3010 inside the stack, unpublished');

  // ── Networks: the database is on the internal network only, which has no route out ─────────────────────────────────
  const networks = config.networks ?? {};
  const internalName = Object.keys(networks).find((n) => n === 'internal');
  check(internalName && networks.internal.internal === true, 'the internal network is internal (no route in or out)');
  check(Object.keys(s('db').networks ?? {}).join() === 'internal', 'the database is on the internal network only');
  check(!Object.keys(s('edge').networks ?? {}).includes('internal'), 'the edge never joins the internal network');
  check(!Object.keys(s('email-proof').networks ?? {}).includes('internal'), 'the email proof never reaches the database');

  // ── Images: MySQL and Caddy pinned to an exact version AND a digest ─────────────────────────────────────────────────
  for (const [name, re] of [
    ['db', /^mysql:8\.4\.\d+@sha256:[0-9a-f]{64}$/],
    ['edge', /^caddy:2\.\d+\.\d+@sha256:[0-9a-f]{64}$/],
  ]) {
    check(re.test(s(name).image ?? ''), `${name} runs a pinned image (exact version and digest)`);
  }

  // ── Resources, restarts, logs ──────────────────────────────────────────────────────────────────────────────────────
  for (const name of ['db', 'api', 'edge']) {
    check(s(name).restart === 'unless-stopped', `${name} restarts unless stopped`);
    check(Number(s(name).mem_limit ?? s(name).deploy?.resources?.limits?.memory ?? 0) > 0, `${name} has a memory limit`);
  }
  for (const [name, service] of Object.entries(services)) {
    const log = service.logging ?? {};
    check(log.driver === 'json-file' && log.options?.['max-size'] && log.options?.['max-file'], `${name} rotates its log`);
  }
  check((s('api').cap_drop ?? []).includes('ALL'), 'the API holds no Linux capability');
  check((s('api').security_opt ?? []).some((o) => /^no-new-privileges(:true)?$/.test(o)), 'the API cannot gain privileges');
  check((s('edge').cap_drop ?? []).includes('ALL') && (s('edge').cap_add ?? []).join() === 'NET_BIND_SERVICE', 'the edge holds only NET_BIND_SERVICE');

  // ── Identity and secrets ───────────────────────────────────────────────────────────────────────────────────────────
  const apiEnv = s('api').environment ?? {};
  for (const [k, v] of Object.entries({ APP_ENV: 'production', NODE_ENV: 'production', API_INGRESS: 'network', PORT: '3010', UPLOAD_DIR: '/app/uploads' })) {
    check(apiEnv[k] === v, `the API runs with ${k}=${v}`);
  }
  check(!('STAGING_CONTACT_OUTBOX' in apiEnv), 'the API environment holds no staging setting');
  const SECRET_NAMES = ['APP_DATABASE_URL', 'DATABASE_URL', 'JWT_ACCESS_SECRET', 'OTP_PEPPER', 'MESSAGING_HASH_KEY', 'PLATFORM_MFA_KEY', 'STAFF_INVITATION_KEY', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN', 'MYSQL_ROOT_PASSWORD'];
  for (const name of ['api', 'edge', 'db']) {
    const e = s(name).environment ?? {};
    for (const secret of SECRET_NAMES) check(!(e[secret] ?? '').trim(), `${name} carries no ${secret} value in its environment (a file only)`);
  }
  check(s('db').environment?.MYSQL_ROOT_HOST === 'localhost', 'MySQL root is reachable from inside its container only');
  const apiMounts = (s('api').volumes ?? []).filter((v) => v.target === '/run/secrets');
  check(apiMounts.length === 1 && apiMounts[0].read_only === true, 'the API reads its secrets from one read-only mount');
  check((s('db').volumes ?? []).filter((v) => v.target === '/secrets').every((v) => v.read_only === true), 'the database reads its secrets read-only');

  console.log(`stack contract (${profile}): ${failures.length === 0 ? 'PASS' : 'FAIL'} — ${Object.keys(services).length} services`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(failures.length === 0 ? 0 : 1);
});
