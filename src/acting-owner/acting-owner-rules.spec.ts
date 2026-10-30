import { ROLE_PERMISSIONS } from '../rbac/role-permissions';
import { ACTING_OWNER_PERMISSIONS, NEVER_DELEGATED, inForce, liveOrScheduled, overlaps } from './acting-owner-rules';

/** The Acting Owner's windows and powers (D225), as pure rules. */

const at = (iso: string) => new Date(iso);
const NOW = at('2026-10-29T12:00:00Z');

describe('in force', () => {
  it('from the start, until the end — not before, not at the end, never once revoked', () => {
    const d = { startsAt: at('2026-10-29T10:00:00Z'), endsAt: at('2026-10-29T18:00:00Z'), revokedAt: null };
    expect(inForce(d, NOW)).toBe(true);
    expect(inForce(d, at('2026-10-29T09:59:59Z'))).toBe(false);
    expect(inForce(d, at('2026-10-29T18:00:00Z'))).toBe(false);
    expect(inForce({ ...d, revokedAt: at('2026-10-29T11:00:00Z') }, NOW)).toBe(false);
  });

  it('without an end, until revoked', () => {
    expect(inForce({ startsAt: at('2026-01-01T00:00:00Z'), endsAt: null, revokedAt: null }, NOW)).toBe(true);
  });

  it('a scheduled appointment is live but not yet in force', () => {
    const d = { startsAt: at('2026-10-30T08:00:00Z'), endsAt: null, revokedAt: null };
    expect(inForce(d, NOW)).toBe(false);
    expect(liveOrScheduled(d, NOW)).toBe(true);
  });
});

describe('one at a time', () => {
  const day = { startsAt: at('2026-10-29T08:00:00Z'), endsAt: at('2026-10-29T20:00:00Z') };
  it('overlapping windows clash; back-to-back ones do not', () => {
    expect(overlaps(day, { startsAt: at('2026-10-29T19:00:00Z'), endsAt: null })).toBe(true);
    expect(overlaps(day, { startsAt: at('2026-10-29T20:00:00Z'), endsAt: null })).toBe(false);
    expect(overlaps({ startsAt: NOW, endsAt: null }, { startsAt: at('2027-01-01T00:00:00Z'), endsAt: null })).toBe(true);
  });
});

describe('the powers', () => {
  it('are the Owner’s, less what is never delegated', () => {
    expect(ACTING_OWNER_PERMISSIONS).toEqual(ROLE_PERMISSIONS.owner.filter((k) => !NEVER_DELEGATED.has(k)));
    for (const key of ['sale.below_cost', 'expense.review', 'return.approve', 'loan.manage', 'transfer.approve', 'closing.perform', 'user.manage', 'branch.manage', 'settings.manage', 'report.view', 'cost.view']) {
      if (ROLE_PERMISSIONS.owner.includes(key)) expect(ACTING_OWNER_PERMISSIONS).toContain(key);
    }
    expect(ACTING_OWNER_PERMISSIONS).not.toContain('integrations.manage');
  });
});
