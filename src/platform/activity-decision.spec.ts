import { decideActivityChange, type ActivityDecisionInput } from './activity-decision';
import { CURRENT_PLAN } from '../billing/pricing-rules';

/**
 * An upgrade at a branch that replaced a store archived this period (D158, docs/73 §11.1): priced against the credit
 * its slot carried — the difference the credit leaves, or nothing, applied at once. Never a request for 0.
 */
const base: ActivityDecisionInput = {
  from: 'electronics',
  to: 'both',
  unpaidTo: null,
  scheduledTo: null,
  pricing: CURRENT_PLAN,
  running: true,
  activated: true,
};

describe('an upgrade priced against a replacement’s credit (D158)', () => {
  it('a credit that covers the dearer fee applies the upgrade now, for nothing', () => {
    expect(decideActivityChange({ ...base, credit: 700 })).toMatchObject({ kind: 'apply_now', change: { kind: 'upgrade', amountNow: 0, effective: 'now' } });
  });

  it('a credit that covers part of it charges the rest; no credit, the plain difference', () => {
    expect(decideActivityChange({ ...base, credit: 600 })).toMatchObject({ kind: 'charge_now', change: { amountNow: 100 } });
    expect(decideActivityChange({ ...base, credit: 300 })).toMatchObject({ kind: 'charge_now', change: { amountNow: 200 } });
    expect(decideActivityChange(base)).toMatchObject({ kind: 'charge_now', change: { amountNow: 200 } });
  });

  it('with no paid month to draw on, or a subscription not activated, it waits for the renewal as before', () => {
    expect(decideActivityChange({ ...base, credit: 700, running: false })).toMatchObject({ kind: 'at_renewal' });
    expect(decideActivityChange({ ...base, credit: 700, activated: false })).toMatchObject({ kind: 'at_renewal' });
  });

  it('a credit never touches a downgrade; an upgrade applied now passes a scheduled change (it withdraws it), never an unpaid one', () => {
    expect(decideActivityChange({ ...base, from: 'both', to: 'electronics', credit: 700 })).toMatchObject({ kind: 'at_renewal', change: { amountNow: 0 } });
    expect(decideActivityChange({ ...base, credit: 700, scheduledTo: 'money_agent' })).toMatchObject({ kind: 'apply_now' });
    expect(decideActivityChange({ ...base, credit: 700, unpaidTo: 'money_agent' })).toEqual({ kind: 'blocked', by: 'money_agent' });
  });
});
