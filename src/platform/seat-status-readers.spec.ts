import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as ts from 'typescript';

/**
 * Who reads `seat_allocations.status`, and who writes it (D176, migration 0097).
 *
 * `scheduled` is the newest status a request can hold: paid for during a free trial, not in force until it ends. A
 * reader that lists the statuses it cares about and leaves `scheduled` out fails OPEN when it is a dedupe — "is there
 * a request for this already?" answers no, and a second charge is priced — and fails closed when it counts what is in
 * force. So every status a reader names, as a list, a single value, a variable or SQL, either includes `scheduled` or
 * is pinned below with the reason it leaves it out. A new reader that does neither fails here, and so does a pin
 * nothing matches any more: the inventory is the code's, never a memory of it.
 *
 * And `scheduled` has exactly one writer: the confirmation made while a trial runs
 * (`SeatAllocationService.scheduleTx`), which moves the status, the payment and the start in one guarded UPDATE and
 * reads them back. 0097's CHECK holds the start and the kind; it cannot hold the payment (MySQL refuses a CHECK on a
 * column a foreign key's referential action writes, error 3823), so this spec holds the rest: no other code path, raw
 * statement, data migration or trigger writes a seat request's status to `scheduled`.
 *
 * Read with the TypeScript parser, not by pattern: a `status` property counts when it sits under a call on a
 * `seatAllocation` delegate or under a `seatAllocations` relation, and its place says what it does — under `data` (or
 * a nested create/update) it writes, under `select` it projects, anywhere else it filters.
 */

const BACKEND = join(__dirname, '..', '..');
const SRC = join(BACKEND, 'src');
const MIGRATIONS = join(BACKEND, 'prisma', 'migrations');

const rel = (path: string) => relative(BACKEND, path).split(sep).join('/');

/** Every source file of the server — no spec, no test world, no declaration file. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__testing__' ? [] : sourceFiles(path);
    return e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') && !e.name.endsWith('.d.ts') ? [path] : [];
  });
}

type Role = 'filter' | 'write' | 'select';

/** One `status` a reader or a writer names, where it names it. */
interface StatusUse {
  file: string;
  /** The class and method, or the function, or the module-level constant, it sits in. */
  within: string;
  line: number;
  role: Role;
  /** `= pending_payment`, `in [paid, granted]`, `= <expression>` for anything not a literal. */
  reads: string;
  /** The statuses named, when they are literals; null for an expression. */
  values: string[] | null;
  node: ts.Node;
  sourceFile: ts.SourceFile;
}

/** One SQL text about `seat_allocations`. */
interface SqlUse {
  file: string;
  within: string;
  line: number;
  text: string;
}

const WRITE_KEYS = new Set(['data', 'create', 'createMany', 'update', 'updateMany', 'upsert', 'connectOrCreate']);

const nameOf = (n: ts.Node): string | null => {
  const name = (n as { name?: ts.Node }).name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : null;
};

const unwrap = (e: ts.Expression): ts.Expression => {
  let x = e;
  while (ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isParenthesizedExpression(x)) x = x.expression;
  return x;
};

/** `SeatAllocationService.requestSeat`, `seatCensus`, `USER_SELECT` — the named code it sits in. */
function withinOf(node: ts.Node): string {
  const parts: string[] = [];
  let constant: string | null = null;
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isClassDeclaration(p)) {
      parts.unshift(nameOf(p) ?? '<anonymous>');
    } else if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && ts.isSourceFile(p.parent.parent.parent)) {
      constant = p.name.text;
    }
  }
  return parts.length > 0 ? parts.join('.') : (constant ?? '<module>');
}

/**
 * Whether a `status` property belongs to a seat request, and where: the property names between it and the call on a
 * `seatAllocation` delegate (or the `seatAllocations` relation) that holds it.
 */
function seatScope(prop: ts.ObjectLiteralElementLike, sf: ts.SourceFile): { path: string[] } | null {
  const path: string[] = [];
  for (let p: ts.Node | undefined = prop.parent; p; p = p.parent) {
    if (ts.isPropertyAssignment(p)) {
      const key = nameOf(p);
      if (key === 'seatAllocations') return { path };
      path.unshift(key ?? '<computed>');
    }
    if (ts.isCallExpression(p)) return /\bseatAllocation\.\w+$/.test(p.expression.getText(sf)) ? { path } : null;
    if (ts.isFunctionLike(p)) return null;
  }
  return null;
}

function describeValue(e: ts.Expression, sf: ts.SourceFile): { reads: string; values: string[] | null } {
  const v = unwrap(e);
  if (ts.isStringLiteral(v)) return { reads: `= ${v.text}`, values: [v.text] };
  if (ts.isObjectLiteralExpression(v) && v.properties.length === 1 && ts.isPropertyAssignment(v.properties[0])) {
    const op = nameOf(v.properties[0]);
    const list = unwrap(v.properties[0].initializer);
    if (ts.isArrayLiteralExpression(list) && list.elements.every((x) => ts.isStringLiteral(x))) {
      const values = list.elements.map((x) => (x as ts.StringLiteral).text);
      return { reads: `${op} [${values.join(', ')}]`, values: op === 'in' ? values : null };
    }
  }
  return { reads: `= ${v.getText(sf).replace(/\s+/g, ' ')}`, values: null };
}

/** The text of a SQL literal or template, its interpolations shown as `?`. */
function sqlText(n: ts.TemplateExpression | ts.NoSubstitutionTemplateLiteral | ts.StringLiteral): string {
  if (ts.isTemplateExpression(n)) return [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join('?');
  return n.text;
}

function scan(): { uses: StatusUse[]; sql: SqlUse[]; computed: { file: string; within: string; key: string }[] } {
  const uses: StatusUse[] = [];
  const sql: SqlUse[] = [];
  const computed: { file: string; within: string; key: string }[] = [];
  for (const path of sourceFiles(SRC)) {
    const text = readFileSync(path, 'utf8');
    if (!/seatAllocation|seat_allocations/.test(text)) continue;
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.ES2021, true);
    const file = rel(path);
    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const visit = (n: ts.Node): void => {
      if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && nameOf(n) === 'status') {
        const scope = seatScope(n, sf);
        if (scope) {
          const role: Role = scope.path.some((k) => WRITE_KEYS.has(k)) ? 'write' : scope.path.includes('select') ? 'select' : 'filter';
          const { reads, values } = ts.isPropertyAssignment(n) ? describeValue(n.initializer, sf) : { reads: `= ${n.name.text}`, values: null };
          uses.push({ file, within: withinOf(n), line: lineOf(n), role, reads, values, node: n, sourceFile: sf });
        }
      }
      // A key computed at run time, written on a seat request: it must be shown never to be the status.
      if (ts.isPropertyAssignment(n) && ts.isComputedPropertyName(n.name)) {
        const scope = seatScope(n, sf);
        if (scope?.path.some((k) => WRITE_KEYS.has(k))) computed.push({ file, within: withinOf(n), key: n.name.getText(sf) });
      }
      if ((ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) && /seat_allocations/.test(n.getText(sf))) {
        sql.push({ file, within: withinOf(n), line: lineOf(n), text: sqlText(n).replace(/\s+/g, ' ').trim() });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { uses, sql, computed };
}

const { uses, sql, computed } = scan();
const key = (u: { file: string; within: string; reads: string }) => `${u.file} ${u.within} ${u.reads}`;

/**
 * The readers that leave `scheduled` out on purpose, each with why. Keyed by file, the code it sits in and what it
 * reads; `count` when the same reading appears more than once there.
 */
const PINNED: { at: string; count?: number; why: string }[] = [
  // ── what is in force: a scheduled request counts nowhere until it starts (I2) ──
  {
    at: "src/entitlement/seat-census.ts seatCensus SQL in [paid, granted]",
    why: 'The census counts the seats in force. Billing and maySeat read this same census, so a scheduled seat is charged and seats nobody until the trial ends.',
  },
  {
    at: 'src/platform/seat-allocation.service.ts SeatAllocationService.heldSeats in [paid, granted]',
    why: 'Seats held now, for the timeline’s seatsAfter. A scheduled seat holds nothing until it is in force.',
  },
  {
    at: 'src/platform/trial/trial-end-roll.ts activateDueAddOnsTx in [paid, granted]',
    why: 'The seats in force after an activation, for the seats_changed event’s seatsAfter. The seat just moved is paid; those still scheduled hold nothing yet.',
  },
  {
    at: 'src/platform/staff-activation-rules.ts evaluateActivation in [paid, granted]',
    why: 'Seats in force held for another pending person. A scheduled seat held for somebody covers nobody else, and scheduledCoverage counts only the unreserved ones.',
  },
  // ── activity changes: 0097's CHECK keeps `scheduled` to seats and stores ──
  {
    at: 'src/billing/renewal.ts applyScheduledActivityChanges = granted',
    why: 'Activity requests only (kind = activity): a downgrade waiting for the renewal is granted. An activity row is never scheduled (ck_seat_alloc_scheduled).',
  },
  {
    at: 'src/platform/seat-allocation.service.ts SeatAllocationService.requestActivityChange in [pending_payment, granted]',
    why: 'The open activity requests of a store (kind = activity). An activity row is never scheduled (ck_seat_alloc_scheduled).',
  },
  {
    at: 'src/platform/seat-allocation.service.ts SeatAllocationService.activityOptions in [pending_payment, granted]',
    why: 'The open activity requests of each store, for the options shown (kind = activity). An activity row is never scheduled.',
  },
  {
    at: 'src/platform/seat-allocation.service.ts SeatAllocationService.confirmNowTx in [pending_payment, granted]',
    why: 'The other open activity requests of a store whose upgrade was just paid, superseded (kind = activity). An activity row is never scheduled.',
  },
  // ── awaiting payment, and nothing else ──
  {
    at: 'src/billing/billing.service.ts BillingService.replacementSlots = pending_payment',
    why: 'A replacement slot is reserved by a store request awaiting payment that takes an archived store’s place (D158). A request with replaces_branch_id is never scheduled (PQ16), and a confirmed one has used its slot.',
  },
  {
    at: 'src/platform/platform.controller.ts PlatformController.dashboard = pending_payment',
    why: 'The console’s count of requests waiting for a payment decision. A scheduled request is decided and paid; it has its own queue (status=scheduled).',
  },
  {
    at: 'src/staff/staff-invitation.service.ts StaffInvitationService.cancel = pending_payment',
    why: 'Withdrawing a person’s account withdraws only what is still unpaid. A seat paid for during the trial stays paid and becomes the store’s (PQ4: paid is paid).',
  },
  {
    at: 'src/platform/seat-allocation.service.ts SeatAllocationService.scheduleTx = pending_payment',
    why: 'The guard of the move into scheduled: only a request awaiting payment is scheduled, once.',
  },
  {
    at: 'src/platform/seat-allocation.service.ts SeatAllocationService.confirmNowTx = pending_payment',
    why: 'The guard of the move into paid at once: only a request awaiting payment.',
  },
  // ── a status carried in a variable ──
  {
    at: 'src/platform/seat-allocation.service.ts SeatAllocationService.closeTx = before.status',
    why: 'The guard of a closing: the row’s own status as it was read, with its version.',
  },
  {
    at: 'src/platform/seat-allocation.service.ts SeatAllocationService.close = before.status',
    why: 'The guard of a closing: the row’s own status as it was read, with its version.',
  },
  {
    at: 'src/platform/seat-allocation.service.ts SeatAllocationService.queue = status',
    why: 'The console’s queue, by the status it asks for. The route’s allowed list names scheduled (asserted below).',
  },
];

/** The SQL predicates on the status: `status IN (…)` and `status = '…'`. */
function sqlReads(text: string): string[] {
  const reads: string[] = [];
  for (const m of text.matchAll(/\bstatus\s+IN\s*\(([^)]*)\)/gi)) {
    reads.push(`SQL in [${m[1].split(',').map((v) => v.trim().replace(/^'|'$/g, '')).join(', ')}]`);
  }
  for (const m of text.matchAll(/\bstatus\s*=\s*'(\w+)'/gi)) reads.push(`SQL = ${m[1]}`);
  return reads;
}

const readers = [
  ...uses.filter((u) => u.role === 'filter').map((u) => ({ at: key(u), names: u.values?.includes('scheduled') ?? false, where: `${u.file}:${u.line}` })),
  ...sql.flatMap((s) =>
    sqlReads(s.text).map((reads) => ({ at: `${s.file} ${s.within} ${reads}`, names: /\bscheduled\b/.test(reads), where: `${s.file}:${s.line}` })),
  ),
];

describe('every reader of a seat request’s status names `scheduled`, or says why not', () => {
  it('finds the readers it must: the dedupes, the Team views, the census, the activation, the sweeper', () => {
    // A scan that found nothing would pass everything below.
    const named = readers.filter((r) => r.names).map((r) => r.at);
    expect(named).toEqual(
      expect.arrayContaining([
        'src/platform/seat-allocation.service.ts SeatAllocationService.requestSeat in [pending_payment, paid, granted, scheduled]',
        'src/platform/seat-allocation.service.ts SeatAllocationService.requestStore in [pending_payment, scheduled]',
        'src/platform/staff-activation-rules.ts SELECT in [pending_payment, paid, granted, scheduled]',
        'src/platform/staff-activation-rules.ts scheduledCoverage in [pending_payment, paid, granted, scheduled]',
        'src/platform/staff-activation-rules.ts scheduledCoverage = scheduled',
        'src/staff/staff-invitation.service.ts StaffInvitationService.describe in [pending_payment, paid, granted, scheduled]',
        'src/users/user-management.service.ts USER_SELECT in [pending_payment, paid, granted, scheduled]',
        'src/platform/trial/trial-end-roll.ts activateDueAddOnsTx = scheduled',
        'src/platform/trial/trial-end-roll.ts TrialEndRoll.run = scheduled',
        'src/platform/trial/trial-end.sweeper.ts TrialEndSweeper.sweep SQL = scheduled',
      ]),
    );
    expect(readers.length).toBeGreaterThanOrEqual(named.length + PINNED.length);
  });

  it('a reader that leaves it out is pinned with its reason — and nothing else leaves it out', () => {
    const unnamed = new Map<string, string[]>();
    for (const r of readers.filter((x) => !x.names)) unnamed.set(r.at, [...(unnamed.get(r.at) ?? []), r.where]);
    const pinned = new Map(PINNED.map((p) => [p.at, p.count ?? 1]));
    // Unpinned: each is a list that could fail open. Name `scheduled` in it, or pin it here with why it must not.
    const unpinned = [...unnamed.entries()].filter(([at, sites]) => pinned.get(at) !== sites.length).map(([at, sites]) => `${at} (${sites.join(', ')})`);
    expect(unpinned).toEqual([]);
    // Stale: a pin nothing matches any more is removed with the code it described.
    expect(PINNED.filter((p) => !unnamed.has(p.at)).map((p) => p.at)).toEqual([]);
    expect(PINNED.every((p) => p.why.length > 40)).toBe(true);
  });

  it('the console’s queue offers `scheduled` among the statuses it can be asked for', () => {
    const path = join(SRC, 'platform', 'seat-requests.controller.ts');
    const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2021, true);
    let allowed: string[] | null = null;
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'allowed' && withinOf(n) === 'SeatRequestsController.seatRequests' && n.initializer) {
        const list = unwrap(n.initializer);
        if (ts.isArrayLiteralExpression(list)) allowed = list.elements.map((e) => (ts.isStringLiteral(e) ? e.text : e.getText(sf)));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(allowed).toEqual(expect.arrayContaining(['pending_payment', 'scheduled', 'paid', 'granted', 'released', 'refused']));
  });
});

describe('`scheduled` has one writer: the confirmation made while a trial runs', () => {
  const writes = uses.filter((u) => u.role === 'write');

  /** For a status written from a variable: the literal values its declared type allows. */
  function declaredValues(u: StatusUse): string[] | null {
    const name = u.reads.replace(/^= /, '');
    for (let p: ts.Node | undefined = u.node.parent; p; p = p.parent) {
      if (ts.isFunctionLike(p)) {
        const param = p.parameters.find((x) => ts.isIdentifier(x.name) && x.name.text === name);
        if (!param?.type || !ts.isUnionTypeNode(param.type)) continue;
        const values = param.type.types.map((t) => (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? t.literal.text : null));
        return values.every((v): v is string => v !== null) ? values : null;
      }
    }
    return null;
  }

  it('every status a seat request is written with is a literal, or a parameter typed as literals', () => {
    expect(writes.length).toBeGreaterThanOrEqual(10);
    const unknown = writes.filter((u) => u.values === null && declaredValues(u) === null).map((u) => `${u.file}:${u.line} ${u.reads}`);
    expect(unknown).toEqual([]);
  });

  it('exactly one of them writes `scheduled`: SeatAllocationService.scheduleTx, behind its guard', () => {
    const writers = writes.filter((u) => (u.values ?? declaredValues(u) ?? []).includes('scheduled')).map((u) => `${u.file} ${u.within}`);
    expect(writers).toEqual(['src/platform/seat-allocation.service.ts SeatAllocationService.scheduleTx']);
    // The same UPDATE guards on the request awaiting payment, at the version read, and sets the payment and the start.
    const [only] = writes.filter((u) => u.values?.includes('scheduled'));
    const update = only.node.parent.parent.parent as ts.ObjectLiteralExpression;
    const text = update.getText(only.sourceFile).replace(/\s+/g, ' ');
    expect(text).toMatch(/where: \{ id: before\.id, status: 'pending_payment', version: before\.version \}/);
    expect(text).toMatch(/paymentId: payment\.id/);
    expect(text).toMatch(/effectiveAt: at\.endsAt/);
  });

  it('a key computed at run time on a seat request is never its status', () => {
    expect(computed).toEqual([{ file: 'src/account/account-deletion.service.ts', within: 'AccountDeletionService.forgetPeople', key: '[column]' }]);
    // …and `column` runs over the three name columns only.
    const text = readFileSync(join(SRC, 'account', 'account-deletion.service.ts'), 'utf8');
    expect(text).toMatch(/for \(const column of \['requestedBy', 'confirmedBy', 'closedBy'\] as const\)/);
  });

  it('no raw SQL statement writes a seat request', () => {
    const writing = sql.filter((s) => /\b(UPDATE|INSERT\s+INTO|REPLACE\s+INTO|DELETE\s+FROM)\s+`?seat_allocations\b/i.test(s.text));
    expect(writing.map((s) => `${s.file}:${s.line}`)).toEqual([]);
    // What the SQL does read, so a new statement is looked at here.
    expect(sql.map((s) => `${s.file} ${s.within}`).sort()).toEqual([
      'src/entitlement/seat-census.ts seatCensus',
      'src/platform/seat-allocation.service.ts SeatAllocationService.scheduleTx',
      'src/platform/trial/trial-end.sweeper.ts TrialEndSweeper.sweep',
    ]);
  });

  it('no migration writes a seat request’s status, and no trigger is on — or touches — seat_allocations', () => {
    const migrations = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, sql: readFileSync(join(MIGRATIONS, e.name, 'migration.sql'), 'utf8') }));
    expect(migrations.map((m) => m.name)).toContain('0097_scheduled_addons');
    const dataWrites = migrations.filter((m) => /\b(UPDATE|INSERT\s+INTO|REPLACE\s+INTO)\s+`?seat_allocations\b/i.test(m.sql)).map((m) => m.name);
    expect(dataWrites).toEqual([]);
    const triggers = migrations.flatMap((m) =>
      [...m.sql.matchAll(/CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?TRIGGER\s+`?(\w+)`?\s+(?:BEFORE|AFTER)\s+(?:INSERT|UPDATE|DELETE)\s+ON\s+`?(\w+)`?\s+FOR\s+EACH\s+ROW([\s\S]*?)^\s*END\s*(?:;|\$\$|\/\/)?\s*$/gim)].map((t) => ({
        migration: m.name,
        trigger: t[1],
        table: t[2],
        body: t[3],
      })),
    );
    // Every trigger ever created is parsed, its body to its own END — so "none on seat_allocations" means something.
    const created = migrations.reduce((n, m) => n + [...m.sql.matchAll(/CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?TRIGGER\b/gi)].length, 0);
    expect(created).toBeGreaterThanOrEqual(50);
    expect(triggers).toHaveLength(created);
    expect(triggers.filter((t) => t.table === 'seat_allocations' || /seat_allocations/.test(t.body)).map((t) => t.trigger)).toEqual([]);
  });
});
