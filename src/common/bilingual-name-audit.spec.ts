import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * D225 audit: where a business's, a store's or a person's name leaves this API without its Arabic twin.
 *
 * Every `name: true` select on a Company, Branch or User, and every `<relation>.name` read of one, either sits next
 * to its `nameAr` (fixed: the Arabic interface can show the Arabic name) or is listed below with the reason it stays
 * Latin-only. A new occurrence that is neither fails here, so the next screen added cannot quietly forget the Arabic
 * name.
 *
 * Classes:
 *  - `latin`: intentionally Latin-only — an immutable or machine-read text (audit payload, log line, push/WhatsApp
 *    template, console row, platform email), an internal check, or a record whose Arabic snapshot would need a new
 *    column (listed in the D225 audit report instead of migrated);
 *  - `other`: not a business, store or person — or a select whose owner is not one of those models.
 *
 * Keys are `file :: enclosing function :: select path or read expression`, so a moved line keeps its classification.
 *
 *   npx jest src/common/bilingual-name-audit.spec.ts
 *   NAMES_AUDIT_DUMP=1 npx jest src/common/bilingual-name-audit.spec.ts   # prints every uncovered occurrence
 */

type Cls = 'latin' | 'other';

const SRC = join(__dirname, '..');
const SCHEMA = join(SRC, '..', 'prisma', 'schema.prisma');
const NAMED_MODELS = ['Company', 'Branch', 'User'];

/** Relation fields of every model, split by whether they point at a Company, Branch or User. */
function relationNames(): { named: Set<string>; others: Set<string> } {
  const named = new Set<string>();
  const others = new Set<string>();
  for (const line of readFileSync(SCHEMA, 'utf8').split('\n')) {
    const m = /^\s+(\w+)\s+([A-Z]\w*)(\[\])?\??\s/.exec(line);
    if (!m) continue;
    if (NAMED_MODELS.includes(m[2])) named.add(m[1]);
    else if (/@relation|\[\]/.test(line) || /^[A-Z]/.test(m[2])) others.add(m[1]);
  }
  for (const n of named) others.delete(n);
  return { named, others };
}

const { named: NAMED_RELATIONS, others: OTHER_RELATIONS } = relationNames();
/** Local names that hold a business, store or person read from the database. */
const NAMED_LOCALS = new Set(['seller', 'store', 'business', 'locker', 'person', 'from', 'me', 'inviter']);
const NAMED_DELEGATES = new Set(['company', 'branch', 'user']);

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === '__testing__') continue;
      out.push(...files(path));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

function unwrap(node: ts.Node): ts.Node {
  let n = node.parent;
  while (n && (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n))) n = n.parent;
  return n;
}

function enclosingFunction(node: ts.Node): { name: string; body: string } {
  let n: ts.Node | undefined = node.parent;
  while (n) {
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isGetAccessor(n)) {
      // An arrow inside a method is named after the method: the key stays readable and stable.
      let named: ts.Node | undefined = n;
      while (named && !(ts.isFunctionDeclaration(named) || ts.isMethodDeclaration(named) || ts.isGetAccessor(named))) {
        if (ts.isVariableDeclaration(named) && ts.isIdentifier(named.name)) break;
        named = named.parent;
      }
      const name =
        named && (ts.isFunctionDeclaration(named) || ts.isMethodDeclaration(named) || ts.isGetAccessor(named) || ts.isVariableDeclaration(named)) && named.name
          ? named.name.getText()
          : '<anonymous>';
      return { name, body: (named ?? n).getText() };
    }
    if (ts.isVariableStatement(n) && ts.isSourceFile(n.parent)) {
      return { name: n.declarationList.declarations[0]?.name.getText() ?? '<module>', body: n.getText() };
    }
    n = n.parent;
  }
  return { name: '<module>', body: '' };
}

interface Owner {
  /** The relation, delegate or constant that owns the select. */
  key: string;
  kind: 'relation' | 'delegate' | 'const' | 'unknown';
}

/** Who a `{ name: true }` object selects from, and the property path down to it. */
function ownerOf(literal: ts.ObjectLiteralExpression): { owner: Owner; path: string[] } {
  const path: string[] = [];
  let obj: ts.Node = literal;
  for (;;) {
    const parent = unwrap(obj);
    if (parent && ts.isPropertyAssignment(parent)) {
      const prop = parent.name.getText();
      path.unshift(prop);
      if (prop !== 'select' && prop !== 'include') return { owner: { key: prop, kind: 'relation' }, path };
      const grand = unwrap(parent.parent);
      obj = parent.parent;
      if (grand && ts.isCallExpression(grand) && ts.isPropertyAccessExpression(grand.expression)) {
        const delegate = grand.expression.expression;
        const model = ts.isPropertyAccessExpression(delegate) ? delegate.name.getText() : delegate.getText();
        path.unshift(`${model}.${grand.expression.name.getText()}`);
        return { owner: { key: model, kind: 'delegate' }, path };
      }
      if (grand && ts.isVariableDeclaration(grand)) {
        path.unshift(grand.name.getText());
        return { owner: { key: grand.name.getText(), kind: 'const' }, path };
      }
      continue;
    }
    if (parent && ts.isVariableDeclaration(parent)) {
      path.unshift(parent.name.getText());
      return { owner: { key: parent.name.getText(), kind: 'const' }, path };
    }
    return { owner: { key: '?', kind: 'unknown' }, path };
  }
}

export interface Finding {
  key: string;
  file: string;
  line: number;
  text: string;
}

function lastName(expr: ts.Expression): string | null {
  let e: ts.Expression = expr;
  while (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/** Every Company/Branch/User name read or selected without its Arabic twin, keyed for the allowlist. */
function scan(): { uncovered: Finding[]; covered: number } {
  const uncovered: Finding[] = [];
  let covered = 0;
  for (const path of files(SRC)) {
    const text = readFileSync(path, 'utf8');
    if (!/\bname\b/.test(text)) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const file = relative(SRC, path).split('\\').join('/');
    const at = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;

    const visit = (node: ts.Node) => {
      // A select: `{ ..., name: true }`.
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText() === 'name' &&
        node.initializer.kind === ts.SyntaxKind.TrueKeyword &&
        ts.isObjectLiteralExpression(node.parent)
      ) {
        const literal = node.parent;
        const { owner, path: selectPath } = ownerOf(literal);
        const relevant =
          owner.kind === 'relation'
            ? !OTHER_RELATIONS.has(owner.key)
            : owner.kind === 'delegate'
              ? NAMED_DELEGATES.has(owner.key)
              : true;
        const pairs = literal.properties.some((p) => p.name?.getText() === 'nameAr');
        if (relevant) {
          if (pairs) covered += 1;
          else
            uncovered.push({
              key: `${file} :: ${enclosingFunction(node).name} :: select ${selectPath.join('.')}`,
              file,
              line: at(node),
              text: literal.getText().replace(/\s+/g, ' ').slice(0, 140),
            });
        }
      }
      // A read: `<relation>.name` or `<relation>?.name`.
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'name') {
        const holder = lastName(node.expression);
        if (holder && (NAMED_RELATIONS.has(holder) || NAMED_LOCALS.has(holder))) {
          const expr = node.expression.getText().replace(/[?!]/g, '');
          const fn = enclosingFunction(node);
          const flat = fn.body.replace(/[?!]/g, '');
          if (flat.includes(`${expr}.nameAr`)) covered += 1;
          else
            uncovered.push({
              key: `${file} :: ${fn.name} :: read ${expr}.name`,
              file,
              line: at(node),
              text: node.parent.getText().replace(/\s+/g, ' ').slice(0, 140),
            });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { uncovered, covered };
}

/** Classified occurrences that stay without their Arabic twin. Generated from the dump, then reviewed by hand. */
const ALLOWED: Record<string, [Cls, string]> = {
  'acquisition/acquisition.service.ts :: report :: select inviterCompany.select': ['latin', 'platform acquisition report, read in the console'],
  'acquisition/acquisition.service.ts :: report :: read company.name': ['latin', 'platform acquisition report, read in the console'],
  'acquisition/acquisition.service.ts :: report :: read a.inviterCompany.name': ['latin', 'platform acquisition report, read in the console'],
  'acquisition/acquisition.service.ts :: businessFacts :: select company.findMany.select': ['latin', 'platform acquisition report, read in the console'],
  'agent/agent-positions.service.ts :: set :: select user.findFirst.select': ['latin', 'immutable snapshot (recordedByName) on an agent record: an Arabic snapshot needs a new column — listed in the D225 audit, not migrated'],
  'agent/agent-positions.service.ts :: set :: read actor.name': ['latin', 'immutable snapshot (recordedByName) on an agent record: an Arabic snapshot needs a new column — listed in the D225 audit, not migrated'],
  'agent/agent-providers.service.ts :: addConfig :: select user.findFirst.select': ['latin', 'immutable snapshot (recordedByName) on an agent record: an Arabic snapshot needs a new column — listed in the D225 audit, not migrated'],
  'agent/agent-providers.service.ts :: addConfig :: read actor.name': ['latin', 'immutable snapshot (recordedByName) on an agent record: an Arabic snapshot needs a new column — listed in the D225 audit, not migrated'],
  'agent/agent-transactions.service.ts :: record :: select user.findFirst.select': ['latin', 'immutable snapshot (recordedByName) on an agent record: an Arabic snapshot needs a new column — listed in the D225 audit, not migrated'],
  'agent/agent-transactions.service.ts :: record :: read actor.name': ['latin', 'immutable snapshot (recordedByName) on an agent record: an Arabic snapshot needs a new column — listed in the D225 audit, not migrated'],
  'agent/agent-transactions.service.ts :: reverse :: select user.findFirst.select': ['latin', 'immutable snapshot (recordedByName) on an agent record: an Arabic snapshot needs a new column — listed in the D225 audit, not migrated'],
  'agent/agent-transactions.service.ts :: reverse :: read actor.name': ['latin', 'immutable snapshot (recordedByName) on an agent record: an Arabic snapshot needs a new column — listed in the D225 audit, not migrated'],
  'agent/agent-transactions.service.ts :: reportMistake :: select user.findFirst.select': ['latin', 'immutable snapshot (recordedByName) on an agent record: an Arabic snapshot needs a new column — listed in the D225 audit, not migrated'],
  'agent/agent-transactions.service.ts :: reportMistake :: read actor.name': ['latin', 'immutable snapshot (recordedByName) on an agent record: an Arabic snapshot needs a new column — listed in the D225 audit, not migrated'],
  'agent/agent-transactions.service.ts :: dismissMistake :: select user.findFirst.select': ['latin', 'immutable snapshot (recordedByName) on an agent record: an Arabic snapshot needs a new column — listed in the D225 audit, not migrated'],
  'agent/agent-transactions.service.ts :: dismissMistake :: read actor.name': ['latin', 'immutable snapshot (recordedByName) on an agent record: an Arabic snapshot needs a new column — listed in the D225 audit, not migrated'],
  'agent/agent-transactions.service.ts :: rebalance :: select user.findFirst.select': ['latin', 'immutable snapshot (recordedByName) on an agent record: an Arabic snapshot needs a new column — listed in the D225 audit, not migrated'],
  'agent/agent-transactions.service.ts :: rebalance :: read actor.name': ['latin', 'immutable snapshot (recordedByName) on an agent record: an Arabic snapshot needs a new column — listed in the D225 audit, not migrated'],
  'billing/billing.service.ts :: replacementSlots :: select branch.findMany.select': ['latin', 'billing notices and their audit: platform text'],
  'billing/grace-roll.ts :: recordDueGraceTx :: select company.select': ['latin', 'billing notices and their audit: platform text'],
  'billing/grace-roll.ts :: recordDueGraceTx :: read sub.company.name': ['latin', 'billing notices and their audit: platform text'],
  'billing/renewal.ts :: applyScheduledActivityChanges :: select branch.findMany.select': ['latin', 'billing notices and their audit: platform text'],
  'closing/closing.service.ts :: anchorCountedFloatsTx :: select user.findFirst.select': ['latin', 'immutable snapshot of who locked the count on the anchor row'],
  'closing/closing.service.ts :: anchorCountedFloatsTx :: read locker.name': ['latin', 'immutable snapshot of who locked the count on the anchor row'],
  'consignment/connections.service.ts :: ensureCounterparty :: select company.findUnique.select': ['other', 'a counterparty has one name of its own (not a business, store or person record)'],
  'consignment/connections.service.ts :: ensureCounterparty :: read company.name': ['other', 'a counterparty has one name of its own (not a business, store or person record)'],
  'entitlement/entitlement.service.ts :: recordFor :: read row.company.name': ['latin', 'seat census: internal counting, never shown'],
  'entitlement/seat-census.ts :: seatCensus :: select branch.findMany.select': ['latin', 'seat census: internal counting, never shown'],
  'loans/loans.service.ts :: closingReminders :: select company.select': ['latin', 'reminder text written into an English stored fallback; the app words it from fields'],
  'notices/notice.service.ts :: readSubject :: select company.findUnique.select': ['latin', 'platform notice subject for WhatsApp/email templates'],
  'notices/notice.service.ts :: readSubject :: read company.name': ['latin', 'platform notice subject for WhatsApp/email templates'],
  'platform/account-provisioning.service.ts :: assertMayDefer :: read company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/account-provisioning.service.ts :: out :: select company.findUniqueOrThrow.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/account-provisioning.service.ts :: out :: select user.findFirstOrThrow.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/account-provisioning.service.ts :: out :: read company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/account-provisioning.service.ts :: createStaff :: select company.findUnique.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/account-provisioning.service.ts :: createStaff :: read company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/account-provisioning.service.ts :: createStaff :: select branch.findMany.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/account-provisioning.service.ts :: personOf :: select user.findFirst.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/account-provisioning.service.ts :: personOf :: select company.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/account-provisioning.service.ts :: requireVerification :: read user.company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/account-provisioning.service.ts :: updateDeferral :: read user.company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/account-provisioning.service.ts :: reissueCode :: read user.company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/account-provisioning.service.ts :: revokeCode :: read user.company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/account-provisioning.service.ts :: cancelAccount :: read user.company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/account-provisioning.service.ts :: listDeferred :: select user.findMany.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/account-provisioning.service.ts :: listDeferred :: select company.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/account-provisioning.service.ts :: listDeferred :: select branch.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/account-provisioning.service.ts :: listDeferred :: read r.company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/account-provisioning.service.ts :: listDeferred :: read ub.branch.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/account-setup-code.service.ts :: spend :: select company.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/account-setup-code.service.ts :: spend :: read row.company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/oversight/oversight.service.ts :: BUSINESS :: select BUSINESS.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/owner-invitation.service.ts :: issue :: select company.findUnique.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/owner-invitation.service.ts :: issue :: select user.findFirst.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/owner-invitation.service.ts :: issue :: read company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/owner-invitation.service.ts :: issue :: read owner.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/owner-invitation.service.ts :: accept :: select company.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/owner-invitation.service.ts :: accept :: read invitation.company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/platform.controller.ts :: mySubscription :: select company.findUniqueOrThrow.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/platform.controller.ts :: mySubscription :: select branches.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/platform.controller.ts :: mySubscription :: select user.findFirst.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/platform.controller.ts :: mySubscription :: read company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/platform.controller.ts :: mySubscription :: read owner.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/portal/portal-session.service.ts :: ownerOf :: select user.findFirst.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/portal/portal-session.service.ts :: ownerOf :: select company.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/portal/portal-session.service.ts :: viewOf :: read owner.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/portal/portal-session.service.ts :: viewOf :: read owner.company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/provisioning.service.ts :: companyOf :: select company.findUnique.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/provisioning.service.ts :: assertMayActivate :: read company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/provisioning.service.ts :: assertMayTakePayment :: read company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/provisioning.service.ts :: setTestStatus :: read company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/provisioning.service.ts :: openStore :: read company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/provisioning.service.ts :: status :: select user.findFirst.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/provisioning.service.ts :: status :: read owner.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/seat-allocation.service.ts :: INCLUDE :: select branch.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/seat-allocation.service.ts :: INCLUDE :: select replaces.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/seat-allocation.service.ts :: INCLUDE :: select user.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/seat-allocation.service.ts :: requestLabel :: read row.branch.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/seat-allocation.service.ts :: view :: read row.branch.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/seat-allocation.service.ts :: view :: read row.user.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/seat-allocation.service.ts :: view :: read row.replaces.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/seat-allocation.service.ts :: subscriptionOf :: select company.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/seat-allocation.service.ts :: requestSeat :: select branch.findFirst.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/seat-allocation.service.ts :: requestSeat :: read branch.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/seat-allocation.service.ts :: requestSeat :: read row.user.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/seat-allocation.service.ts :: outcome :: select branch.findFirst.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/seat-allocation.service.ts :: outcome :: read branch.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/seat-allocation.service.ts :: activityOptions :: select branch.findMany.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/seat-allocation.service.ts :: stores :: read branch.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/seat-allocation.service.ts :: confirmPayment :: read sub.company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/seat-allocation.service.ts :: confirmPayment :: read before.branch.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/seat-allocation.service.ts :: confirmPayment :: read before.user.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/seat-allocation.service.ts :: confirmNowTx :: read before.branch.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/seat-allocation.service.ts :: reservedSlotTx :: select branch.findFirst.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/seat-allocation.service.ts :: close :: select company.findUnique.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/seat-allocation.service.ts :: close :: read company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/seat-allocation.service.ts :: queue :: select company.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/seat-allocation.service.ts :: queue :: read r.company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/staff-activation-rules.ts :: SELECT :: select SELECT': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/staff-activation-rules.ts :: SELECT :: select branch.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/staff-activation-rules.ts :: stores :: read ub.branch.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/subscription-lifecycle.service.ts :: loadOrThrow :: select company.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/subscription-lifecycle.service.ts :: activateByGrant :: read before.company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/subscription-lifecycle.service.ts :: approve :: read before.company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/subscription-lifecycle.service.ts :: reject :: read before.company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/subscription-lifecycle.service.ts :: setPeriodEnd :: read before.company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/subscription-lifecycle.service.ts :: extend :: read before.company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/subscription-lifecycle.service.ts :: suspend :: read before.company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/subscription-lifecycle.service.ts :: reinstate :: read before.company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/subscription-lifecycle.service.ts :: cancel :: read before.company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/subscription-lifecycle.service.ts :: recordPayment :: read sub.company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/trial/trial-end-roll.ts :: activateDueAddOnsTx :: select company.findUnique.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/trial/trial-end-roll.ts :: activateDueAddOnsTx :: select branch.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/trial/trial-end-roll.ts :: activateDueAddOnsTx :: select user.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/trial/trial-end-roll.ts :: activateDueAddOnsTx :: read company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/trial/trial-end-roll.ts :: activateDueAddOnsTx :: read row.branch.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/trial/trial-end-roll.ts :: activateDueAddOnsTx :: read row.user.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/trial/trial-end-roll.ts :: factsOf :: select company.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/trial/trial-end-roll.ts :: factsOf :: read row.company.name': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'platform/trial/trial-facts.ts :: readFacts :: select company.findUnique.select': ['latin', 'platform console, provisioning, invitation or billing text: read by the platform team, not the Arabic interface'],
  'returns/return-notifications.ts :: emit :: select user.findFirst.select': ['latin', 'the stored English fallback text of a notification; the app words it from fields'],
  'returns/return-notifications.ts :: emit :: read actor.name': ['latin', 'the stored English fallback text of a notification; the app words it from fields'],
  'staff/staff-invitation.service.ts :: invite :: select branch.findMany.select': ['latin', 'WhatsApp invitation template variable and its audit record'],
  'staff/staff-invitation.service.ts :: invite :: select user.findFirst.select': ['latin', 'WhatsApp invitation template variable and its audit record'],
  'staff/staff-invitation.service.ts :: cancel :: select user.findUniqueOrThrow.select': ['latin', 'WhatsApp invitation template variable and its audit record'],
  'staff/staff-invitation.service.ts :: cancel :: read actor.name': ['latin', 'WhatsApp invitation template variable and its audit record'],
  'staff/staff-invitation.service.ts :: open :: read invitation.company.name': ['latin', 'WhatsApp invitation template variable and its audit record'],
  'staff/staff-invitation.service.ts :: open :: read invitation.user.name': ['latin', 'WhatsApp invitation template variable and its audit record'],
  'staff/staff-invitation.service.ts :: confirm :: read invitation.company.name': ['latin', 'WhatsApp invitation template variable and its audit record'],
  'staff/staff-invitation.service.ts :: confirm :: read invitation.user.name': ['latin', 'WhatsApp invitation template variable and its audit record'],
  'staff/staff-invitation.service.ts :: usable :: select company.select': ['latin', 'WhatsApp invitation template variable and its audit record'],
  'staff/staff-invitation.service.ts :: usable :: select user.select': ['latin', 'WhatsApp invitation template variable and its audit record'],
  'staff/staff-invitation.service.ts :: describe :: select user.findUniqueOrThrow.select': ['latin', 'WhatsApp invitation template variable and its audit record'],
  'staff/staff-invitation.service.ts :: describe :: select branch.select': ['latin', 'WhatsApp invitation template variable and its audit record'],
  'staff/staff-invitation.service.ts :: seats :: read ub.branch.name': ['latin', 'WhatsApp invitation template variable and its audit record'],
  'staff/staff-invitation.service.ts :: describe :: read ub.branch.name': ['latin', 'WhatsApp invitation template variable and its audit record'],
  'transfers/transfers.service.ts :: create :: read toBranch.name': ['latin', 'an English API error message'],
  'users/role-change.service.ts :: outcome :: select user.findFirst.select': ['other', 'an internal lookup: the name is not returned'],
  'users/user-management.service.ts :: assignment :: select branch.select': ['latin', 'written into the immutable delegation audit record'],
  'users/user-management.service.ts :: assignment :: read found.branch.name': ['latin', 'written into the immutable delegation audit record'],
};

describe('D225 bilingual names audit', () => {
  const { uncovered, covered } = scan();

  if (process.env.NAMES_AUDIT_DUMP) {
    // eslint-disable-next-line no-console
    console.log(`covered=${covered}\n` + uncovered.map((f) => `${f.key}\t${f.file}:${f.line}\t${f.text}`).join('\n'));
  }

  it('finds the selects and reads it audits (the scanner is not blind)', () => {
    expect(covered).toBeGreaterThan(40);
  });

  it('classifies every business, store or person name returned without its Arabic name', () => {
    const unclassified = [...new Set(uncovered.map((f) => f.key))].filter((k) => !(k in ALLOWED));
    expect(unclassified).toEqual([]);
  });

  it('keeps no stale entry: a fixed or removed occurrence leaves the list', () => {
    const found = new Set(uncovered.map((f) => f.key));
    expect(Object.keys(ALLOWED).filter((k) => !found.has(k))).toEqual([]);
  });
});
