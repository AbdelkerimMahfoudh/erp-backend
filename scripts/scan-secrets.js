#!/usr/bin/env node
/**
 * Secret scan of the WHOLE git history (docs/48 §1.2, control 2).
 *
 *   node scripts/scan-secrets.js            # every commit reachable from any ref
 *   node scripts/scan-secrets.js --worktree # the current files only (pre-commit)
 *
 * Why a script of our own beside gitleaks: the CI job runs gitleaks, but a
 * scan that needs a binary downloaded from GitHub cannot run on every machine
 * this project is worked on, and a control that cannot be run is a control
 * nobody runs. This walks every blob in every commit with plain `git` and
 * Node, and exits non-zero on a finding. It knows the shapes of the secrets
 * THIS project handles — provider tokens, peppers, JWT secrets, database
 * URLs with passwords, private keys — and nothing about anybody's SaaS.
 *
 * Deliberately conservative: an example file may name a variable, never a
 * value that looks real. Findings name the commit, the path and the line;
 * they never print the secret itself.
 */
const { execFileSync } = require('node:child_process');

const PATTERNS = [
  { name: 'private key', re: /-----BEGIN (RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/ },
  { name: 'Meta/WhatsApp access token', re: /\bEAA[A-Za-z0-9]{20,}\b/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  // A database URL with a real-looking password (placeholders in <angle brackets> and the dev fixtures are allowed below).
  { name: 'database URL with password', re: /\bmysql:\/\/[A-Za-z0-9_]+:([^<@\s"']{6,})@/ },
  // A committed value for a secret variable. Names first, then anything that is not empty, a placeholder or a reference.
  {
    name: 'secret variable with a value',
    re: /\b(JWT_ACCESS_SECRET|OTP_PEPPER|WHATSAPP_ACCESS_TOKEN|WHATSAPP_APP_SECRET|WHATSAPP_WEBHOOK_VERIFY_TOKEN|PLATFORM_ADMIN_KEY|PLATFORM_ADMIN_PASSWORD|OWNER_SEED_PASSWORD|BACKUP_PASSPHRASE)\s*[=:]\s*["']?([^\s"'<$#][^\s"']{7,})/,
  },
];

/** Values that look like secrets and are not: the documented dev fixtures and obvious placeholders. */
const ALLOW = [
  /migrator_dev_pw|app_dev_pw|admin_dev_pw|backup_dev_pw/, // the disposable-database fixtures named in docs
  /<[a-z-]+>/, // <placeholder>
  /change-me|changeme|example|placeholder|your-|xxxx|\.\.\./i,
  /process\.env\./, // a reference, not a value
  /randomBytes|generate|node -e/, // an instruction to generate one
  /\bJoi\./, // a schema definition
  /user:password@|user:pass@/, // documentation of the URL shape
];

/** A bare identifier after `KEY:` is a variable reference (`JWT_ACCESS_SECRET: tokenSecret`), not a literal. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*[,;)]?$/;

/**
 * A repository may name fixtures of its own in `.secret-scan-allow`: one
 * regular expression per line, `#` comments allowed. Each entry is reviewed
 * like code — it is the list of things that look like secrets and are not.
 */
function repoAllowlist() {
  try {
    return require('node:fs')
      .readFileSync('.secret-scan-allow', 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => new RegExp(l));
  } catch {
    return [];
  }
}
ALLOW.push(...repoAllowlist());

const args = new Set(process.argv.slice(2));
const worktreeOnly = args.has('--worktree');

function git(...a) {
  return execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28 });
}

/** Paths never scanned: lockfiles and vendored assets are noise, and this script and its tests describe the patterns. */
const SKIP_PATH = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.(png|jpg|jpeg|gif|ico|woff2?|ttf|pdf|xlsx)$|scan-secrets/;

function scanText(text, where, findings) {
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (line.length > 4000) return; // minified bundles; a secret hides badly in one anyway
    for (const p of PATTERNS) {
      const m = p.re.exec(line);
      if (!m) continue;
      const value = m[2] ?? m[1] ?? m[0];
      if (p.name === 'secret variable with a value' && IDENTIFIER.test(value)) continue;
      if (ALLOW.some((a) => a.test(line) || a.test(value))) continue;
      findings.push(`${where}:${i + 1}: ${p.name}`);
    }
  });
}

function scanWorktree(findings) {
  const files = git('ls-files', '-z').split('\0').filter(Boolean);
  for (const f of files) {
    if (SKIP_PATH.test(f)) continue;
    let text;
    try {
      text = require('node:fs').readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    scanText(text, f, findings);
  }
  return files.length;
}

function scanHistory(findings) {
  // Every blob in every commit reachable from any ref, each blob scanned once.
  const commits = git('rev-list', '--all').split('\n').filter(Boolean);
  const seen = new Set();
  let blobs = 0;
  for (const commit of commits) {
    const tree = git('ls-tree', '-r', '-z', commit).split('\0').filter(Boolean);
    for (const entry of tree) {
      const [meta, path] = entry.split('\t');
      const sha = meta.split(' ')[2];
      if (!sha || seen.has(sha) || SKIP_PATH.test(path)) continue;
      seen.add(sha);
      blobs++;
      let text;
      try {
        text = git('cat-file', '-p', sha);
      } catch {
        continue;
      }
      if (text.includes('\u0000')) continue; // binary
      scanText(text, `${commit.slice(0, 10)}:${path}`, findings);
    }
  }
  return { commits: commits.length, blobs };
}

const findings = [];
if (worktreeOnly) {
  const n = scanWorktree(findings);
  console.log(`scanned ${n} tracked files in the working tree`);
} else {
  const { commits, blobs } = scanHistory(findings);
  console.log(`scanned ${blobs} distinct blobs across ${commits} commits (every ref)`);
}

if (findings.length === 0) {
  console.log('no secrets found');
  process.exit(0);
}
console.log(`${findings.length} finding(s):`);
for (const f of findings) console.log(`  ${f}`);
process.exit(1);
