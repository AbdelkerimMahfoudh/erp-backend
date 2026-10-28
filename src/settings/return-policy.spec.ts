import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { normalisePolicyText, policyTextFor, policyTextProblem, POLICY_TEXT_MAX } from './return-policy-rules';
import { effectivePolicy, ReturnPolicyService } from './return-policy.service';

/**
 * A branch's written return policy (0108, the owner's brief of 2026-10-28).
 *
 * The shop's own words, stored exactly and safely, edited only for a branch the
 * person works in, audited, and printed on a receipt in its own language — or
 * the shop's default language, or the neutral sentence. Never translated.
 */

describe('the written conditions are stored exactly and safely', () => {
  it('normalises whitespace the same way every time, keeping line breaks', () => {
    expect(normalisePolicyText('  We accept returns\r\n\r\n\r\n\twith  the   box.  \n')).toBe('We accept returns\n\nwith the box.');
    expect(normalisePolicyText('a\u0007b')).toBe('ab');
    expect(normalisePolicyText('   ')).toBeNull();
    expect(normalisePolicyText(undefined)).toBeNull();
  });

  it('refuses markup rather than stripping it, and bounds the length', () => {
    expect(policyTextProblem('<b>no</b> returns')).toBe('html');
    expect(policyTextProblem('Returns &amp; exchanges')).toBe('html');
    expect(policyTextProblem('Returns within 2 days < 3 days')).toBeNull();
    expect(policyTextProblem('x'.repeat(POLICY_TEXT_MAX))).toBeNull();
    expect(policyTextProblem('x'.repeat(POLICY_TEXT_MAX + 1))).toBe('too_long');
  });

  it('prints the receipt language, else the default language, else nothing — never a translation', () => {
    const texts = { en: 'EN', fr: null, ar: 'AR', defaultLanguage: 'ar' as const };
    expect(policyTextFor(texts, 'en')).toBe('EN');
    expect(policyTextFor(texts, 'fr')).toBe('AR');
    expect(policyTextFor({ en: null, fr: null, ar: null, defaultLanguage: 'en' }, 'fr')).toBeNull();
  });
});

const COMPANY = Buffer.alloc(16, 1);
const BRANCH = Buffer.alloc(16, 2);
const OTHER_BRANCH = Buffer.alloc(16, 3);
const USER = Buffer.alloc(16, 4);

function harness(seed: { assigned?: boolean; own?: Record<string, unknown> | null; companyHours?: number } = {}) {
  const rows = new Map<string, Record<string, unknown>>();
  if (seed.own) rows.set(BRANCH.toString('hex'), { branchId: BRANCH, companyId: COMPANY, ...seed.own });
  const audits: Record<string, unknown>[] = [];
  const branchReturnPolicy = {
    findFirst: async ({ where }: { where: { branchId: Buffer } }) => rows.get(where.branchId.toString('hex')) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => (rows.set((data.branchId as Buffer).toString('hex'), data), data),
    updateMany: async ({ where, data }: { where: { branchId: Buffer; version: number }; data: Record<string, unknown> }) => {
      const row = rows.get(where.branchId.toString('hex'));
      if (!row || row.version !== where.version) return { count: 0 };
      rows.set(where.branchId.toString('hex'), { ...row, ...data });
      return { count: 1 };
    },
  };
  const db = {
    branchReturnPolicy,
    companySettings: { findUnique: async () => ({ returnWindowHours: seed.companyHours ?? 0 }) },
    userBranch: { findFirst: async () => (seed.assigned === false ? null : { id: Buffer.alloc(16, 9) }) },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  const tenant = { companyId: () => COMPANY, requireBranchId: () => BRANCH, requireUserId: () => USER };
  const audit = { recordTx: async (_tx: unknown, entry: Record<string, unknown>) => void audits.push(entry) };
  return { service: new ReturnPolicyService(db as never, tenant as never, audit as never), rows, audits, db };
}

const POLICY = { windowHours: 72, textEn: 'Manufacturing defects only, with the box.', textAr: 'عيوب التصنيع فقط، مع العلبة.', defaultLanguage: 'en' };

describe('editing the branch policy', () => {
  it('a branch without its own policy sells under the company window, with no written conditions', async () => {
    const h = harness({ companyHours: 48 });
    expect(await effectivePolicy(h.db as never, COMPANY, BRANCH)).toEqual({ windowHours: 48, textEn: null, textFr: null, textAr: null, defaultLanguage: 'en', version: null });
  });

  it('saves the first policy as version 1, and audits who, where, what changed and both sides', async () => {
    const h = harness();
    const out = await h.service.update({ ...POLICY });
    expect(out).toMatchObject({ windowHours: 72, version: 1, changed: true, languagesChanged: ['en', 'ar'], windowChanged: true });
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({ entityType: 'BranchReturnPolicy', entityId: BRANCH, branchId: BRANCH, before: { windowHours: 0, textEn: null }, after: { windowHours: 72, version: 1 } });
    expect(String(h.audits[0].reason)).toMatch(/window 0h → 72h; conditions \(en, ar\)/);
  });

  it('refuses a branch the person is not assigned to — another branch or company is never theirs to edit', async () => {
    const h = harness({ assigned: false });
    await expect(h.service.update({ ...POLICY })).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.rows.size).toBe(0);
    expect(h.audits).toHaveLength(0);
  });

  it('refuses markup and over-long text, naming the field', async () => {
    const h = harness();
    await expect(h.service.update({ ...POLICY, textFr: '<script>x</script>' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.service.update({ ...POLICY, textEn: 'x'.repeat(1001) })).rejects.toBeInstanceOf(BadRequestException);
    expect(h.rows.size).toBe(0);
  });

  it('a concurrent change is refused, never overwritten', async () => {
    const h = harness({ own: { windowHours: 24, textEn: null, textFr: null, textAr: null, defaultLanguage: 'en', version: 3 } });
    await expect(h.service.update({ ...POLICY, expectedVersion: 2 })).rejects.toBeInstanceOf(ConflictException);
    const ok = await h.service.update({ ...POLICY, expectedVersion: 3 });
    expect(ok).toMatchObject({ version: 4, changed: true });
  });

  it('saving the same policy again changes nothing and audits nothing', async () => {
    const h = harness({ own: { windowHours: 72, textEn: POLICY.textEn, textFr: null, textAr: POLICY.textAr, defaultLanguage: 'en', version: 1 } });
    const out = await h.service.update({ ...POLICY, textEn: `  ${POLICY.textEn}  ` });
    expect(out).toMatchObject({ changed: false, version: 1 });
    expect(h.audits).toHaveLength(0);
  });

  it("one branch's policy never answers for another branch", async () => {
    const h = harness({ own: { windowHours: 72, textEn: 'A', textFr: null, textAr: null, defaultLanguage: 'en', version: 1 }, companyHours: 0 });
    expect((await effectivePolicy(h.db as never, COMPANY, OTHER_BRANCH)).windowHours).toBe(0);
  });
});
