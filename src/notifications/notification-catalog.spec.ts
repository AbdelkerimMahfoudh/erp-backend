import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { classify, defaultLevel, knownTypes, shouldPush, typesIn } from './notification-catalog';

/** The notification matrix (D225): which events are pushed under which level, and to whom never. */

const push = (type: string, level: 'all' | 'important' | 'approvals', recipientId = 'r', actorId: string | null = 'a') =>
  shouldPush({ type, level, recipientId, actorId });

describe('the three levels', () => {
  it('All activity pushes every authorized event, routine sales included', () => {
    for (const type of ['sale.recorded', 'stock.received', 'transfer.received', 'return.requested']) expect(push(type, 'all')).toBe(true);
  });

  it('Important pushes returns, money, staff and approvals — not routine sales or receiving', () => {
    expect(push('return.approved', 'important')).toBe(true);
    expect(push('debt.charged', 'important')).toBe(true);
    expect(push('anomaly.cash_shortfall', 'important')).toBe(true);
    expect(push('staff.role_changed', 'important')).toBe(true);
    expect(push('discount_approval.requested', 'important')).toBe(true);
    expect(push('sale.recorded', 'important')).toBe(false);
    expect(push('stock.received', 'important')).toBe(false);
  });

  it('Approvals only pushes what waits for a decision', () => {
    for (const type of ['discount_approval.requested', 'return.requested', 'transfer.requested', 'loan.proposed', 'consignment.requested', 'return.refund_reported']) {
      expect(push(type, 'approvals')).toBe(true);
    }
    for (const type of ['sale.recorded', 'return.approved', 'debt.charged', 'staff.role_changed']) expect(push(type, 'approvals')).toBe(false);
  });

  it('critical security events reach the person whatever their level', () => {
    expect(push('acting_owner.appointed', 'approvals')).toBe(true);
    expect(push('acting_owner.revoked', 'important')).toBe(true);
  });
});

describe('never to the actor', () => {
  it('your own action is never pushed to you, even critical, even under All activity', () => {
    expect(push('sale.recorded', 'all', 'u1', 'u1')).toBe(false);
    expect(push('acting_owner.appointed', 'all', 'owner', 'owner')).toBe(false);
  });

  it('an event with no known actor follows the level', () => {
    expect(push('return.requested', 'approvals', 'u1', null)).toBe(true);
  });
});

describe('defaults and filters', () => {
  it('Important for Owners and Managers, Approvals only for Employees', () => {
    expect(defaultLevel(['owner'])).toBe('important');
    expect(defaultLevel(['store_manager', 'store_employee'])).toBe('important');
    expect(defaultLevel(['store_employee'])).toBe('approvals');
  });

  it('each filter lists its types; an unknown type is shown under All and pushed only under All activity', () => {
    expect(typesIn('approvals')).toContain('discount_approval.requested');
    expect(typesIn('sales')).toContain('sale.recorded');
    expect(typesIn('stock')).toContain('stock.received');
    expect(typesIn('money')).toContain('debt.charged');
    expect(classify('something.new')).toEqual({ category: 'other', importance: 'routine' });
    expect(push('something.new', 'important')).toBe(false);
  });

  it('every literal notification type the server writes is classified', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.spec.ts') && !p.includes('__testing__')) files.push(p);
      }
    };
    walk(join(__dirname, '..'));
    const written = new Set<string>();
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (!/notification\.create|notifications\.emit/.test(src)) continue;
      for (const m of src.matchAll(/type: '([a-z_]+\.[a-z_.]+)'/g)) written.add(m[1]);
    }
    expect([...written].filter((t) => !knownTypes().includes(t))).toEqual([]);
  });
});
