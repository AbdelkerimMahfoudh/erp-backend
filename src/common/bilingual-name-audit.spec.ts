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
const ALLOWED: Record<string, [Cls, string]> = {};

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
