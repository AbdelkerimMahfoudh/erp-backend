import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where a sale's money landed (4a).
 *
 * `createSale` is one long transaction over eight collaborators, and — as
 * `sale-policy-snapshot.spec.ts` sets out — a double for it mostly proves that
 * the double agrees with itself. So the decisions a future edit could quietly
 * undo are pinned against the source, and the rules they depend on are tested
 * directly where they are pure.
 *
 * Five properties matter here, and each has cost a real shop money somewhere:
 *
 *   1. Non-cash money must name the account it reached.
 *   2. A deactivated account may not take new money.
 *   3. Another company's account can never be referenced.
 *   4. What the receipt said is frozen, so a later rename cannot rewrite it.
 *   5. Cash belongs to no account, and a retry must not take payment twice.
 */

const SRC = join(__dirname);
const service = readFileSync(join(SRC, 'sales.service.ts'), 'utf8');

/** The payment block: from attributing the money to writing the row. */
const paymentBlock = service.slice(
  service.indexOf('for (const pay of dto.payments)'),
  service.indexOf('if (dto.customerId && balanceDue > 0)'),
);

describe('a non-cash payment must say where the money went', () => {
  it('refuses a card, mobile or bank payment with no account', () => {
    expect(paymentBlock).toMatch(/pay\.method !== 'cash' && !accountBin/);
    expect(paymentBlock).toMatch(/Choose the account this money was received into/);
  });

  it('still forces cash to no account at all', () => {
    /*
     * The drawer belongs to no account, and `ck_payments_cash_no_account`
     * refuses the alternative at the database level anyway.
     */
    expect(paymentBlock).toMatch(/pay\.method === 'cash' \|\| !pay\.receivingAccountId \? null/);
  });
});

describe('the account has to be one this shop can actually use', () => {
  it('refuses an account that is no longer active', () => {
    expect(paymentBlock).toMatch(/!account\.isActive/);
    expect(paymentBlock).toMatch(/no longer active/);
  });

  it('refuses an account that does not exist', () => {
    expect(paymentBlock).toMatch(/That receiving account does not exist/);
  });

  it('reads the account through the tenant client, so another company cannot be named', () => {
    /*
     * The tenant extension injects `companyId` into the where clause, so an id
     * belonging to another company is simply not found and falls into the
     * refusal above. A raw client here would defeat that silently.
     */
    expect(paymentBlock).toMatch(/tx\.receivingAccount\.findFirst\(/);
    expect(paymentBlock).not.toMatch(/prisma\.receivingAccount/);
  });

  it('selects exactly what it needs to decide and to snapshot', () => {
    expect(paymentBlock).toMatch(/select: \{ label: true, provider: true, providerName: true, isActive: true \}/);
  });
});

describe('what the receipt said is frozen', () => {
  it('freezes the label at payment time', () => {
    expect(paymentBlock).toMatch(/accountLabelSnapshot: account\?\.label \?\? null/);
  });

  it('freezes the provider beside it, naming the configured service for `other`', () => {
    /*
     * The label alone was not enough: renaming "Bankily – Main Counter" to
     * "Counter 1" left a reprinted receipt unable to say which service the
     * money came through, and switching an account's provider would make every
     * earlier payment look like it used the new one.
     */
    expect(paymentBlock).toMatch(/accountProviderSnapshot:/);
    expect(paymentBlock).toMatch(/account\.provider === 'other'/);
    expect(paymentBlock).toMatch(/account\.providerName \?\? 'other'/);
  });

  it('snapshots nothing when there is no account — cash records no provider', () => {
    expect(paymentBlock).toMatch(/: null,/);
  });
});

describe('the money is attributed once, and only once', () => {
  it('writes exactly one payment row per payment line', () => {
    expect(paymentBlock.match(/tx\.payment\.create\(/g)).toHaveLength(1);
  });

  it('an offline retry replays the original sale rather than taking payment again', () => {
    // The idempotency check runs before anything is written, keyed on the
    // client's own uuid; this pins that the guard still precedes the work.
    const guard = service.indexOf('if (dto.clientUuid)');
    const payments = service.indexOf('for (const pay of dto.payments)');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(payments);
  });
});

describe('the schema keeps the snapshot honest', () => {
  const schema = readFileSync(join(SRC, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
  const payment = schema.slice(schema.indexOf('model Payment {'), schema.indexOf('model Payment {') + 2000);

  it('stores the provider snapshot as its own nullable column', () => {
    expect(payment).toMatch(/accountProviderSnapshot String\? @map\("account_provider_snapshot"\)/);
  });

  it('leaves historical payments NULL rather than guessing a provider', () => {
    const migration = readFileSync(
      join(SRC, '..', '..', 'prisma', 'migrations', '0069_payment_provider_snapshot', 'migration.sql'),
      'utf8',
    );
    expect(migration).toMatch(/ADD COLUMN `account_provider_snapshot` VARCHAR\(60\) NULL/);
    expect(migration).not.toMatch(/\bUPDATE\s+`?payments`?/i);
  });
});
