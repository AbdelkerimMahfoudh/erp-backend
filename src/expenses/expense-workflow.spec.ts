import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  assertAmount,
  assertClassAndDueDate,
  assertDayOpen,
  assertDecidable,
  assertMethodAndAccount,
  assertNotConfirmed,
  assertSalaryIsFixed,
  fingerprintExpense,
  needsReasonWarning,
} from './expense-rules';
import { ExpensesController } from './expenses.controller';
import { REQUIRE_PERMISSIONS_KEY } from '../rbac/require-permissions.decorator';
import { ROLE_PERMISSIONS } from '../../prisma/seed-data/permissions';

/**
 * The expense workflow (Milestone D).
 *
 * The D0 audit found three defects, and most of what is asserted here exists to
 * keep them fixed: a report used to be final, a cash expense never reduced
 * expected cash, and there was no channel at all.
 */

const SRC = __dirname;
const service = readFileSync(join(SRC, 'expenses.service.ts'), 'utf8');
const rollup = readFileSync(join(SRC, '..', 'analytics', 'rollup.service.ts'), 'utf8');
const closing = readFileSync(join(SRC, '..', 'closing', 'closing.service.ts'), 'utf8');
const migration = readFileSync(
  join(SRC, '..', '..', 'prisma', 'migrations', '0044_expense_workflow', 'migration.sql'),
  'utf8',
);

/** Strip comments, so an assertion cannot pass by matching its own prose. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the channel decides what touches the drawer', () => {
  it('accepts cash with no account, and an account with one', () => {
    expect(() => assertMethodAndAccount('cash', null)).not.toThrow();
    expect(() => assertMethodAndAccount('account', 'some-id')).not.toThrow();
  });

  it('refuses cash carrying an account, and an account with none', () => {
    expect(() => assertMethodAndAccount('cash', 'some-id')).toThrow(BadRequestException);
    expect(() => assertMethodAndAccount('account', null)).toThrow(BadRequestException);
  });
});

describe('the two accounting classes', () => {
  it('a variable expense has no due date', () => {
    expect(() => assertClassAndDueDate('variable', null)).not.toThrow();
    expect(() => assertClassAndDueDate('variable', '2026-08-16')).toThrow(BadRequestException);
  });

  it('a fixed expense needs one', () => {
    expect(() => assertClassAndDueDate('fixed', '2026-08-16')).not.toThrow();
    expect(() => assertClassAndDueDate('fixed', null)).toThrow(BadRequestException);
  });

  it('a salary is fixed, never variable', () => {
    expect(() => assertSalaryIsFixed(true, 'fixed')).not.toThrow();
    expect(() => assertSalaryIsFixed(true, 'variable')).toThrow(BadRequestException);
    expect(() => assertSalaryIsFixed(false, 'variable')).not.toThrow();
  });

  it('an amount must be positive', () => {
    expect(() => assertAmount(10)).not.toThrow();
    for (const bad of [0, -1, Number.NaN]) expect(() => assertAmount(bad)).toThrow(BadRequestException);
  });
});

describe('lifecycle', () => {
  it('only a reported expense can be decided', () => {
    expect(() => assertDecidable({ status: 'reported' })).not.toThrow();
    expect(() => assertDecidable({ status: 'confirmed' })).toThrow(/already confirmed/);
    expect(() => assertDecidable({ status: 'rejected' })).toThrow(/already rejected/);
  });

  it('a confirmed expense is never edited — it is corrected', () => {
    expect(() => assertNotConfirmed({ status: 'confirmed' })).toThrow(/correction/i);
    expect(() => assertNotConfirmed({ status: 'reported' })).not.toThrow();
  });

  it('a variable expense never lands on a closed day', () => {
    expect(() => assertDayOpen({ isLocked: false }, '2026-08-16')).not.toThrow();
    expect(() => assertDayOpen(null, '2026-08-16')).not.toThrow();
    expect(() => assertDayOpen({ isLocked: true }, '2026-08-16')).toThrow(ConflictException);
  });

  it('the locked-day conflict uses the shared code', () => {
    try {
      assertDayOpen({ isLocked: true }, '2026-08-16');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ConflictException).getResponse()).toMatchObject({ code: 'day_already_closed' });
    }
  });
});

describe('the missing-reason warning', () => {
  it('is needed when no note was given', () => {
    expect(needsReasonWarning({ note: null })).toBe(true);
    expect(needsReasonWarning({ note: '   ' })).toBe(true);
  });

  it('is not needed when one was', () => {
    expect(needsReasonWarning({ note: 'electricity bill' })).toBe(false);
  });

  /**
   * The state is stored, not the copy. "Miscellaneous" in a ledger is
   * indistinguishable from a real category a year later.
   */
  it('is recorded as an explicit state, never as placeholder text', () => {
    expect(code(service)).toMatch(/reasonOmitted/);
    expect(service).not.toMatch(/'Miscellaneous'|"Miscellaneous"/);
  });
});

describe('idempotency', () => {
  const base = {
    category: 'Electricity',
    amount: 1200,
    method: 'cash' as const,
    expenseClass: 'variable' as const,
  };

  it('is stable for the same payload and ignores surrounding whitespace', () => {
    expect(fingerprintExpense(base)).toBe(fingerprintExpense({ ...base, category: ' Electricity ' }));
  });

  it('changes with the amount, the channel and the class', () => {
    expect(fingerprintExpense({ ...base, amount: 1201 })).not.toBe(fingerprintExpense(base));
    expect(fingerprintExpense({ ...base, method: 'account', receivingAccountId: 'a' })).not.toBe(
      fingerprintExpense(base),
    );
    expect(
      fingerprintExpense({ ...base, expenseClass: 'fixed', dueDate: '2026-09-01' }),
    ).not.toBe(fingerprintExpense(base));
  });
});

describe('permissions — the split the model could not previously express', () => {
  it('reporting and reading need expense.submit', () => {
    for (const m of ['create', 'list', 'detail'] as const) {
      expect(Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, ExpensesController.prototype[m])).toEqual([
        'expense.submit',
      ]);
    }
  });

  it('confirming and rejecting need expense.review — a DIFFERENT key', () => {
    for (const m of ['confirm', 'reject'] as const) {
      expect(Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, ExpensesController.prototype[m])).toEqual([
        'expense.review',
      ]);
    }
  });

  it('all three store roles may submit', () => {
    for (const role of ['owner', 'store_manager', 'store_employee'] as const) {
      expect(ROLE_PERMISSIONS[role]).toContain('expense.submit');
    }
  });

  it('ONLY the Owner may review', () => {
    expect(ROLE_PERMISSIONS.owner).toContain('expense.review');
    expect(ROLE_PERMISSIONS.store_manager).not.toContain('expense.review');
    expect(ROLE_PERMISSIONS.store_employee).not.toContain('expense.review');
  });

  it('expense.manage is NOT widened — it stays Owner-only', () => {
    expect(ROLE_PERMISSIONS.owner).toContain('expense.manage');
    expect(ROLE_PERMISSIONS.store_manager).not.toContain('expense.manage');
    expect(ROLE_PERMISSIONS.store_employee).not.toContain('expense.manage');
  });

  /**
   * The rule that keeps `expense.submit` from becoming company-wide visibility:
   * somebody who may report what they spent must not thereby see the shop's
   * whole outgoings.
   */
  it('a submitter sees only their OWN expenses', () => {
    expect(code(service)).toMatch(/seesAll\(\)[\s\S]{0,80}reportedById/);
    expect(code(service)).toMatch(/seesAll\(\)[\s\S]{0,120}expense\.review/);
  });

  it('the migration grants exactly that', () => {
    expect(migration).toMatch(/'expense\.submit'[\s\S]{0,400}?'owner', 'store_manager', 'store_employee'/);
    expect(migration).toMatch(/'expense\.review'[\s\S]{0,400}?r\.`key` = 'owner'/);
  });
});

describe('accounting — the three defects stay fixed', () => {
  it('ONLY confirmed expenses reach the day', () => {
    const block = rollup.slice(rollup.indexOf('FROM expenses'), rollup.indexOf('FROM expenses') + 400);
    expect(block).toMatch(/status = 'confirmed'/);
  });

  it('a variable expense is keyed on its CONFIRMATION date', () => {
    expect(rollup).toMatch(/expense_class = 'variable' AND confirmation_date = \$\{day\}/);
  });

  it('a fixed expense is keyed on its DUE date, never spread across days', () => {
    expect(rollup).toMatch(/expense_class = 'fixed' AND due_date = \$\{day\}/);
  });

  it('salaries are summed separately from other fixed costs', () => {
    expect(rollup).toMatch(/is_salary = 1 THEN amount END\), 0\)\s+AS expenses_salary/);
    expect(rollup).toMatch(/expense_class = 'fixed' THEN amount END\), 0\) AS expenses_fixed/);
  });

  it('only CASH expenses are separated for the till', () => {
    expect(rollup).toMatch(/method = 'cash' THEN amount END\), 0\)\s+AS expenses_cash/);
  });

  /** The audit's second finding: this figure did not exist at all. */
  it('expected cash subtracts cash expenses, exactly once', () => {
    expect(closing).toMatch(/- expensesCash/);
    expect((closing.match(/- expensesCash/g) ?? []).length).toBe(1);
  });

  it('the reconciliation equation has every movement once', () => {
    const eq = closing.slice(closing.indexOf('const expectedCash'), closing.indexOf('const difference'));
    for (const term of ['refundedCash', 'supplierPaid.cash', 'expensesCash', 'correctedCash']) {
      expect((eq.match(new RegExp(term.replace('.', '\\.'), 'g')) ?? []).length).toBe(1);
    }
  });

  it('a report changes no figure — no recompute is queued', () => {
    const create = service.slice(service.indexOf('async create('), service.indexOf('async confirm('));
    expect(code(create)).not.toMatch(/enqueueDailyRecompute/);
  });

  it('a rejection changes no figure either', () => {
    const reject = service.slice(service.indexOf('async reject('), service.indexOf('async list('));
    expect(code(reject)).not.toMatch(/enqueueDailyRecompute/);
  });

  it('confirmation recomputes the RIGHT day for each class', () => {
    expect(code(service)).toMatch(/expenseClass === 'fixed' && expense\.dueDate\s*\?\s*dayKey\(expense\.dueDate\)/);
  });
});

describe('accounts and immutability', () => {
  it('reporting requires an ACTIVE account', () => {
    expect(code(service)).toMatch(/isActive: true/);
  });

  it('the label is snapshotted at report time', () => {
    expect(code(service)).toMatch(/accountLabelSnapshot: accountLabel/);
  });

  it('a confirmed expense cannot be deleted by the application', () => {
    expect(migration).toMatch(/expenses_block_delete/);
    expect(migration).toMatch(/OLD\.`status` = 'confirmed'/);
  });

  it('a malformed id is a 404, not a 500', () => {
    expect(code(service)).toMatch(/isUuid\(idStr\)/);
  });

  it('decisions are guarded on version AND status, so one owner wins', () => {
    const confirm = service.slice(service.indexOf('async confirm('), service.indexOf('async reject('));
    expect(confirm).toMatch(/version: dto\.expectedVersion/);
    expect(confirm).toMatch(/status: 'reported'/);
    expect(confirm).toMatch(/refresh_required/);
  });

  it('a supplier payment and a refund are still NOT expenses', () => {
    // Both are liability settlements. Neither is written through this service.
    expect(code(service)).not.toMatch(/supplierSettlement|refundPayout/);
  });
});
