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
 * Read with the TypeScript parser, not by pattern, from every place a seat request's query is built: the arguments of
 * a call on a `seatAllocation` delegate, the value of a `seatAllocations` relation, and anything typed as one of
 * Prisma's `SeatAllocation…` inputs (a declaration, `as` or `satisfies`, a function's return type, a parameter's
 * default). From there it follows what the query is built from — a variable to every value it is given, a shorthand
 * `{ where }`, a spread, either side of a condition — and a `status` met on the way counts, its place saying what it
 * does: under `data` (or a nested create/update) it writes, under `select` it projects, anywhere else it filters. A
 * part it cannot read (a parameter, a call's result, an import) where a status could sit — an argument, the value of
 * `where`, `data`, `select` and the like, a spread — is listed as well, and must be pinned with why it holds none
 * (review 2026-10-16: a status list or a writer built in a variable was missed).
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

/** A part of a seat request's query the scan cannot read, where a status could sit. */
interface OpaqueUse {
  file: string;
  within: string;
  line: number;
  /** The keys above it in the query; `(argument)` for a call's argument. */
  at: string;
  text: string;
}

const WRITE_KEYS = new Set(['data', 'create', 'createMany', 'update', 'updateMany', 'upsert', 'connectOrCreate']);
/** The keys whose value is itself a part of the query: a status, or a part holding one, can sit there. */
const STRUCTURAL = new Set([...WRITE_KEYS, 'where', 'select', 'include', 'some', 'none', 'every', 'is', 'isNot', 'OR', 'AND', 'NOT']);
/** Prisma's types for a seat request's query parts: an object of one of them is a seat query, wherever it is built. */
const SEAT_INPUT = /^(?:Prisma\.)?SeatAllocation\w*(?:Input|Args|Select|Include|Filter)$/;

const nameOf = (n: ts.Node): string | null => {
  const name = (n as { name?: ts.Node }).name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : null;
};

const unwrap = (e: ts.Expression): ts.Expression => {
  let x = e;
  while (ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x)) x = x.expression;
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

function binds(name: ts.BindingName, text: string): boolean {
  if (ts.isIdentifier(name)) return name.text === text;
  return name.elements.some((e) => !ts.isOmittedExpression(e) && binds(e.name, text));
}

/**
 * Every value a name is given where it is visible: a `const`'s initializer; a `let`'s initializer and each assignment
 * to it. Null when the name is not a variable declared here — a parameter, a binding taken apart from another value, a
 * loop's or a catch's variable, an import: what it holds cannot be read.
 */
function valuesOf(id: ts.Identifier): ts.Expression[] | null {
  for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && scope.parameters.some((p) => binds(p.name, id.text))) return null;
    if (ts.isCatchClause(scope) && scope.variableDeclaration && binds(scope.variableDeclaration.name, id.text)) return null;
    if (
      (ts.isForOfStatement(scope) || ts.isForInStatement(scope) || ts.isForStatement(scope)) &&
      scope.initializer &&
      ts.isVariableDeclarationList(scope.initializer) &&
      scope.initializer.declarations.some((d) => binds(d.name, id.text))
    ) {
      return null;
    }
    const statements = ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope) ? scope.statements : null;
    for (const st of statements ?? []) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (!binds(d.name, id.text)) continue;
        if (!ts.isIdentifier(d.name)) return null;
        const values: ts.Expression[] = d.initializer ? [d.initializer] : [];
        if ((st.declarationList.flags & ts.NodeFlags.Const) === 0) {
          const assigned = (n: ts.Node): void => {
            if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && n.left.text === id.text) values.push(n.right);
            ts.forEachChild(n, assigned);
          };
          assigned(scope);
        }
        return values;
      }
    }
  }
  return null;
}

/** The value itself when it is named by a `const` (through `as const` and the like), else the expression. */
function literal(e: ts.Expression): ts.Expression {
  let v = unwrap(e);
  for (let hops = 0; ts.isIdentifier(v) && hops < 5; hops += 1) {
    const values = valuesOf(v);
    if (!values || values.length !== 1) break;
    v = unwrap(values[0]);
  }
  return v;
}

function describeValue(e: ts.Expression, sf: ts.SourceFile): { reads: string; values: string[] | null } {
  const v = literal(e);
  if (ts.isStringLiteral(v)) return { reads: `= ${v.text}`, values: [v.text] };
  if (ts.isObjectLiteralExpression(v) && v.properties.length === 1 && ts.isPropertyAssignment(v.properties[0])) {
    const op = nameOf(v.properties[0]);
    const list = literal(v.properties[0].initializer);
    if (ts.isArrayLiteralExpression(list) && list.elements.every((x) => ts.isStringLiteral(x))) {
      const values = list.elements.map((x) => (x as ts.StringLiteral).text);
      return { reads: `${op} [${values.join(', ')}]`, values: op === 'in' ? values : null };
    }
  }
  return { reads: `= ${unwrap(e).getText(sf).replace(/\s+/g, ' ')}`, values: null };
}

/** The text of a SQL literal or template, its interpolations shown as `?`. */
function sqlText(n: ts.TemplateExpression | ts.NoSubstitutionTemplateLiteral | ts.StringLiteral): string {
  if (ts.isTemplateExpression(n)) return [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join('?');
  return n.text;
}

/** The seat input a type names, if it names one. */
function seatType(type: ts.TypeNode | undefined, sf: ts.SourceFile): string | null {
  let found: string | null = null;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isTypeReferenceNode(n) && SEAT_INPUT.test(n.typeName.getText(sf))) {
      found = n.typeName.getText(sf);
      return;
    }
    ts.forEachChild(n, visit);
  };
  if (type) visit(type);
  return found;
}

/** Where an object of a seat input sits in a query: a filter, data, a projection — or the query's arguments. */
function pathOfType(name: string): string[] {
  if (/Where\w*Input$/.test(name)) return ['where'];
  if (/(?:Create|Update|Upsert)\w*Input$/.test(name)) return ['data'];
  if (/Select$/.test(name)) return ['select'];
  if (/Include$/.test(name)) return ['include'];
  if (/OrderBy\w*Input$/.test(name)) return ['orderBy'];
  return [];
}

/** What a function returns: its expression body, or each `return` of its own (not of a function inside it). */
function returnsOf(fn: ts.SignatureDeclaration): ts.Expression[] {
  const body = (fn as ts.FunctionLikeDeclaration).body;
  if (!body) return [];
  if (!ts.isBlock(body)) return [body];
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(body, visit);
  return out;
}

const isScalarLiteral = (e: ts.Expression): boolean =>
  ts.isStringLiteral(e) ||
  ts.isNoSubstitutionTemplateLiteral(e) ||
  ts.isNumericLiteral(e) ||
  e.kind === ts.SyntaxKind.TrueKeyword ||
  e.kind === ts.SyntaxKind.FalseKeyword ||
  e.kind === ts.SyntaxKind.NullKeyword ||
  (ts.isIdentifier(e) && e.text === 'undefined');

/** Scan source texts — the server's, or a fixture's. */
function scanSources(files: { file: string; text: string }[]) {
  const uses: StatusUse[] = [];
  const sql: SqlUse[] = [];
  const computed: { file: string; within: string; key: string }[] = [];
  const opaque: OpaqueUse[] = [];
  for (const { file, text } of files) {
    if (!/seatAllocation|seat_allocations|SeatAllocation/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2021, true);
    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const counted = new Set<ts.Node>();
    const unread = new Set<ts.Node>();
    const walked = new Set<string>();

    const status = (prop: ts.PropertyAssignment | ts.ShorthandPropertyAssignment, path: string[]): void => {
      if (counted.has(prop)) return;
      counted.add(prop);
      const role: Role = path.some((k) => WRITE_KEYS.has(k)) ? 'write' : path.includes('select') ? 'select' : 'filter';
      const { reads, values } = ts.isPropertyAssignment(prop) ? describeValue(prop.initializer, sf) : { reads: `= ${prop.name.text}`, values: null };
      uses.push({ file, within: withinOf(prop), line: lineOf(prop), role, reads, values, node: prop, sourceFile: sf });
    };

    /** A value in a seat query at `path`: read through, or — where a status could sit — listed as unread. */
    const value = (e: ts.Expression, path: string[], structural: boolean): void => {
      const v = unwrap(e);
      if (ts.isObjectLiteralExpression(v)) return object(v, path);
      if (ts.isArrayLiteralExpression(v)) {
        for (const el of v.elements) value(ts.isSpreadElement(el) ? el.expression : el, path, structural || ts.isSpreadElement(el));
        return;
      }
      if (ts.isConditionalExpression(v)) {
        value(v.whenTrue, path, structural);
        value(v.whenFalse, path, structural);
        return;
      }
      if (
        ts.isBinaryExpression(v) &&
        [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(v.operatorToken.kind)
      ) {
        value(v.left, path, structural);
        value(v.right, path, structural);
        return;
      }
      if (ts.isIdentifier(v)) {
        const values = valuesOf(v);
        if (values) {
          for (const x of values) value(x, path, structural);
          return;
        }
      }
      if (!structural || isScalarLiteral(v) || unread.has(v)) return;
      unread.add(v);
      opaque.push({ file, within: withinOf(v), line: lineOf(v), at: path.join('.') || '(argument)', text: v.getText(sf).replace(/\s+/g, ' ') });
    };

    const object = (o: ts.ObjectLiteralExpression, path: string[]): void => {
      const seen = `${o.pos}:${o.end}:${path.join('.')}`;
      if (walked.has(seen)) return;
      walked.add(seen);
      for (const prop of o.properties) {
        if (ts.isSpreadAssignment(prop)) {
          value(prop.expression, path, true);
          continue;
        }
        if (ts.isShorthandPropertyAssignment(prop)) {
          const k = prop.name.text;
          if (k === 'status') status(prop, path);
          else if (k === 'seatAllocations') value(prop.name, [], true);
          else value(prop.name, [...path, k], STRUCTURAL.has(k));
          continue;
        }
        if (!ts.isPropertyAssignment(prop)) continue;
        if (ts.isComputedPropertyName(prop.name)) {
          // A key computed at run time, written on a seat request: it must be shown never to be the status.
          if (path.some((k) => WRITE_KEYS.has(k))) computed.push({ file, within: withinOf(prop), key: prop.name.getText(sf) });
          continue;
        }
        const k = nameOf(prop) ?? '<computed>';
        if (k === 'status') status(prop, path);
        else if (k === 'seatAllocations') value(prop.initializer, [], true);
        else value(prop.initializer, [...path, k], STRUCTURAL.has(k));
      }
    };

    const visit = (n: ts.Node): void => {
      // A call on a seat request's delegate: its arguments are the query.
      if (ts.isCallExpression(n) && /\bseatAllocation\.\w+$/.test(n.expression.getText(sf))) for (const a of n.arguments) value(a, [], true);
      // The relation, in another model's query.
      if (ts.isPropertyAssignment(n) && nameOf(n) === 'seatAllocations') value(n.initializer, [], true);
      if (ts.isShorthandPropertyAssignment(n) && n.name.text === 'seatAllocations') value(n.name, [], true);
      // Anything typed as one of Prisma's seat inputs, wherever it is built and however it reaches a query.
      if (ts.isVariableDeclaration(n) && n.initializer) {
        const t = seatType(n.type, sf);
        if (t) value(n.initializer, pathOfType(t), true);
      }
      if (ts.isParameter(n) && n.initializer) {
        const t = seatType(n.type, sf);
        if (t) value(n.initializer, pathOfType(t), true);
      }
      if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) {
        const t = seatType(n.type, sf);
        if (t) value(n.expression, pathOfType(t), true);
      }
      if (ts.isFunctionLike(n) && n.type) {
        const t = seatType(n.type, sf);
        if (t) for (const r of returnsOf(n)) value(r, pathOfType(t), true);
      }
      if ((ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) && /seat_allocations/.test(n.getText(sf))) {
        sql.push({ file, within: withinOf(n), line: lineOf(n), text: sqlText(n).replace(/\s+/g, ' ').trim() });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { uses, sql, computed, opaque };
}

function scan() {
  return scanSources(sourceFiles(SRC).map((path) => ({ file: rel(path), text: readFileSync(path, 'utf8') })));
}

const { uses, sql, computed, opaque } = scan();
const key = (u: { file: string; within: string; reads: string }) => `${u.file} ${u.within} ${u.reads}`;

/**
 * The parts of a seat query the scan cannot read that hold no status, each with why. None today: every seat query in
 * the server is built from literals and variables the scan follows.
 */
const UNREAD_PINNED: { at: string; why: string }[] = [];

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

/** Every reader a scan found — each status filter and each SQL predicate — and whether it names `scheduled`. */
function readersOf(found: Pick<ReturnType<typeof scanSources>, 'uses' | 'sql'>) {
  return [
    ...found.uses.filter((u) => u.role === 'filter').map((u) => ({ at: key(u), names: u.values?.includes('scheduled') ?? false, where: `${u.file}:${u.line}` })),
    ...found.sql.flatMap((s) =>
      sqlReads(s.text).map((reads) => ({ at: `${s.file} ${s.within} ${reads}`, names: /\bscheduled\b/.test(reads), where: `${s.file}:${s.line}` })),
    ),
  ];
}

/** The readers that leave `scheduled` out and are not pinned (or not as many times as pinned): each could fail open. */
function unpinnedReaders(found: ReturnType<typeof readersOf>, pins: typeof PINNED): string[] {
  const unnamed = new Map<string, string[]>();
  for (const r of found.filter((x) => !x.names)) unnamed.set(r.at, [...(unnamed.get(r.at) ?? []), r.where]);
  const pinned = new Map(pins.map((p) => [p.at, p.count ?? 1]));
  return [...unnamed.entries()].filter(([at, sites]) => pinned.get(at) !== sites.length).map(([at, sites]) => `${at} (${sites.join(', ')})`);
}

/** The parts of a seat query the scan could not read, unpinned. */
const unpinnedUnread = (found: OpaqueUse[], pins: typeof UNREAD_PINNED): string[] =>
  found.map((o) => `${o.file} ${o.within} ${o.at} ${o.text}`).filter((at) => !pins.some((p) => p.at === at));

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

/** The code that writes a seat request's status to `scheduled`. */
const scheduledWriters = (found: StatusUse[]): string[] =>
  found.filter((u) => u.role === 'write' && (u.values ?? declaredValues(u) ?? []).includes('scheduled')).map((u) => `${u.file} ${u.within}`);

const readers = readersOf({ uses, sql });

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
    // Unpinned: each is a list that could fail open. Name `scheduled` in it, or pin it here with why it must not.
    expect(unpinnedReaders(readers, PINNED)).toEqual([]);
    // Stale: a pin nothing matches any more is removed with the code it described.
    const unnamed = new Set(readers.filter((r) => !r.names).map((r) => r.at));
    expect(PINNED.filter((p) => !unnamed.has(p.at)).map((p) => p.at)).toEqual([]);
    expect(PINNED.every((p) => p.why.length > 40)).toBe(true);
  });

  it('every part of a seat query is read — a variable, a shorthand, a spread, a typed literal — or pinned with why it holds no status', () => {
    expect(unpinnedUnread(opaque, UNREAD_PINNED)).toEqual([]);
    const unread = new Set(opaque.map((o) => `${o.file} ${o.within} ${o.at} ${o.text}`));
    expect(UNREAD_PINNED.filter((p) => !unread.has(p.at)).map((p) => p.at)).toEqual([]);
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

  it('every status a seat request is written with is a literal, or a parameter typed as literals', () => {
    expect(writes.length).toBeGreaterThanOrEqual(10);
    const unknown = writes.filter((u) => u.values === null && declaredValues(u) === null).map((u) => `${u.file}:${u.line} ${u.reads}`);
    expect(unknown).toEqual([]);
  });

  it('exactly one of them writes `scheduled`: SeatAllocationService.scheduleTx, behind its guard', () => {
    expect(scheduledWriters(uses)).toEqual(['src/platform/seat-allocation.service.ts SeatAllocationService.scheduleTx']);
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
      // The trial's end takes each due request by its primary key with NOWAIT before moving it (N1): no status read.
      'src/platform/trial/trial-end-roll.ts NOWAIT',
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

describe('a query built in a variable is read like one written in place (review 2026-10-16)', () => {
  const fixture = (name: string, text: string) => scanSources([{ file: `fixture/${name}.ts`, text }]);

  it('the verifier’s dedupe — a status list in a typed `where`, passed by shorthand: found, and refused unpinned', () => {
    const found = fixture(
      'dedupe',
      `
      class SeatDedupe {
        async requestSeat(companyId: Buffer) {
          const where: Prisma.SeatAllocationWhereInput = { companyId, kind: 'seat', status: { in: ['pending_payment', 'paid', 'granted'] } };
          return this.prisma.seatAllocation.findFirst({ where });
        }
      }`,
    );
    expect(unpinnedReaders(readersOf(found), PINNED)).toEqual(['fixture/dedupe.ts SeatDedupe.requestSeat in [pending_payment, paid, granted] (fixture/dedupe.ts:4)']);
  });

  it('the verifier’s second writer — a typed `data` writing scheduled with no payment, passed by shorthand: found, and refused', () => {
    const found = fixture(
      'writer',
      `
      class SecondWriter {
        async schedule(id: Buffer, at: Date) {
          const data: Prisma.SeatAllocationUncheckedUpdateManyInput = { status: 'scheduled', effectiveAt: at };
          await this.prisma.seatAllocation.updateMany({ where: { id }, data });
        }
      }`,
    );
    expect(scheduledWriters(found.uses)).toEqual(['fixture/writer.ts SecondWriter.schedule']);
    // Beside the server's one writer, two: the check above would fail.
    expect([...scheduledWriters(uses), ...scheduledWriters(found.uses)]).toHaveLength(2);
  });

  it('every other way of building one — untyped, the argument itself, a spread, a `let` changed later, a list in a constant, `satisfies`, a function’s return', () => {
    const found = fixture(
      'forms',
      `
      const OPEN = ['pending_payment', 'paid'] as const;
      class Forms {
        async untyped(companyId: Buffer) {
          const where = { companyId, status: { in: ['pending_payment', 'paid'] } };
          return this.prisma.seatAllocation.findMany({ where });
        }
        async argument() {
          const args = { where: { status: 'paid' } };
          return this.prisma.seatAllocation.findMany(args);
        }
        async spread(id: Buffer) {
          const base = { status: 'scheduled' as const };
          await this.prisma.seatAllocation.updateMany({ where: { id }, data: { ...base, version: { increment: 1 } } });
        }
        async later(id: Buffer, late: boolean) {
          let data: Record<string, unknown> = { version: { increment: 1 } };
          if (late) data = { status: 'released' };
          await this.prisma.seatAllocation.updateMany({ where: { id }, data });
        }
        async constant() {
          return this.prisma.seatAllocation.count({ where: { status: { in: OPEN } } });
        }
        satisfying() {
          return { status: 'granted' } satisfies Prisma.SeatAllocationWhereInput;
        }
      }
      function heldFilter(): Prisma.SeatAllocationWhereInput {
        return { status: { in: ['paid', 'granted'] } };
      }`,
    );
    expect(found.uses.map((u) => `${u.within} ${u.role} ${u.reads}`).sort()).toEqual([
      'Forms.argument filter = paid',
      'Forms.constant filter in [pending_payment, paid]',
      'Forms.later write = released',
      'Forms.satisfying filter = granted',
      'Forms.spread write = scheduled',
      'Forms.untyped filter in [pending_payment, paid]',
      'heldFilter filter in [paid, granted]',
    ]);
    expect(scheduledWriters(found.uses)).toEqual(['fixture/forms.ts Forms.spread']);
    expect(found.opaque).toEqual([]);
  });

  it('a part it cannot read where a status could be — a parameter, a call’s result, a spread of either, the whole argument — is listed, and refused unpinned', () => {
    const found = fixture(
      'unread',
      `
      class Unread {
        async fromParameter(where: object) {
          return this.prisma.seatAllocation.findMany({ where });
        }
        async fromCall(id: Buffer) {
          await this.prisma.seatAllocation.updateMany({ where: { id }, data: this.patch() });
        }
        async spreadParameter(filters: object) {
          return this.prisma.seatAllocation.findMany({ where: { companyId: 1, ...filters } });
        }
        async argument(args: object) {
          return this.prisma.seatAllocation.findMany(args);
        }
      }`,
    );
    expect(unpinnedUnread(found.opaque, UNREAD_PINNED)).toEqual([
      'fixture/unread.ts Unread.fromParameter where where',
      'fixture/unread.ts Unread.fromCall data this.patch()',
      'fixture/unread.ts Unread.spreadParameter where filters',
      'fixture/unread.ts Unread.argument (argument) args',
    ]);
  });
});
