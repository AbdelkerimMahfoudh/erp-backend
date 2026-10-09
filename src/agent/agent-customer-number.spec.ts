import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * The customer number of an exchange (docs/73 §4.6, A6; the D151 pattern): a
 * person's contact detail, taken at the counter, stored once, shown in full
 * only on the detail route to `agent.customer.reveal` — and nowhere a list, a
 * report, an export, a notification, an audit row or the server log would show
 * it. A new file naming it fails here until somebody decides it belongs there.
 */

const SRC = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

/** The number itself — not its last four digits, not its masked form. */
const NAMES_THE_NUMBER = /customerNumber(?!Last4|Masked)|customer_number(?!_last4)/;

describe('where the customer number is named', () => {
  const ALLOWED = ['agent/agent-rules.ts', 'agent/agent-transactions.service.ts', 'agent/dto/transaction.dto.ts'];

  it('is named only where it is taken, normalised, stored and read on the detail', () => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && NAMES_THE_NUMBER.test(readFileSync(path, 'utf8'))) {
          found.push(relative(SRC, path).split(sep).join('/'));
        }
      }
    };
    walk(SRC);
    expect(found.sort()).toEqual(ALLOWED);
  });
});

describe('inside the transactions service', () => {
  const service = read('agent', 'agent-transactions.service.ts');

  it('selects the column in exactly one place — the detail’s select — and the list’s select never does', () => {
    expect(service.match(/customerNumber: true/g)).toHaveLength(1);
    const listSelect = service.slice(service.indexOf('const listSelect = {'), service.indexOf('} satisfies Prisma.AgentTransactionSelect;'));
    expect(listSelect).not.toMatch(NAMES_THE_NUMBER);
    expect(service).toMatch(/const detailSelect = \{ \.\.\.listSelect, customerNumber: true \}/);
    // The list route never asks for it; the detail asks only when the caller may reveal.
    expect(service).toMatch(/select: listSelect,\s*\/\/ A UUIDv7 key/);
    expect(service).toMatch(/select: reveal \? detailSelect : listSelect/);
    expect(service).toMatch(/const reveal = this\.cls\.get\('permissions'\)\?\.has\('agent\.customer\.reveal'\) \?\? false;/);
  });

  it('the view emits it only when revealed, and the audit row of an exchange carries nothing of it', () => {
    expect(service).toMatch(/\.\.\.\(reveal && row\.customerNumber !== undefined \? \{ customerNumber: row\.customerNumber \} : \{\}\)/);
    const record = service.slice(service.indexOf('async record('), service.indexOf('private async replayTransaction('));
    const audit = record.slice(record.indexOf('await this.audit.recordTx('), record.indexOf('branchId,', record.indexOf('await this.audit.recordTx(')));
    expect(audit).not.toMatch(/customerNumber|customer|last4/i);
  });

  it('the list filters on the last four digits only; the reference is its own column', () => {
    expect(service).toMatch(/customerNumberLast4: query\.last4/);
    expect(service).not.toMatch(/customerNumber: \{ contains/);
  });
});

describe('beyond the service', () => {
  it('the reports, the positions, the providers and the closing never read it; the agent module sends no notification', () => {
    for (const file of ['agent/agent-reports.service.ts', 'agent/agent-positions.service.ts', 'agent/agent-providers.service.ts', 'agent/float-positions.ts', 'closing/closing.service.ts', 'closing/closing-report.ts', 'closing/closing-report.queries.ts', 'analytics/rollup.service.ts']) {
      expect([file, NAMES_THE_NUMBER.test(read(...file.split('/')))]).toEqual([file, false]);
    }
    for (const file of readdirSync(join(SRC, 'agent')).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))) {
      expect([file, /notifications|NotificationsService|emit\(/.test(read('agent', file))]).toEqual([file, false]);
    }
  });

  it('the refusal of a malformed number names the problem, never the number (its message reaches the log)', () => {
    const rules = read('agent', 'agent-rules.ts');
    const refusal = rules.slice(rules.indexOf('export function customerNumberFor'), rules.indexOf('export function maskedCustomerNumber'));
    expect(refusal).toMatch(/code: 'customer_number_invalid', message/);
    expect(refusal).not.toMatch(/\$\{raw\}|\$\{parsed\.value\}/);
  });
});
