import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isValidTac,
  reconcileDualSim,
  resolveTac,
  tacFromImei,
  type CompanyMapping,
  type GlobalEntry,
} from './tac-resolution';
import { TacMappingController } from './tac-mapping.controller';
import { REQUIRE_PERMISSIONS_KEY } from '../rbac/require-permissions.decorator';
import { ROLE_PERMISSIONS } from '../../prisma/seed-data/permissions';

/**
 * The TAC resolution ladder (Milestone C).
 *
 * The property under test throughout: **a company's confirmation is
 * authoritative for that company and invisible to every other one, and the
 * globally shared catalogue never names a tenant's product.**
 */

const GLOBAL: GlobalEntry = { brand: 'Samsung', model: 'Galaxy A14', defaultVariant: '128GB' };
const P1 = '0192f1a0-0000-7000-8000-000000000001';
const P2 = '0192f1a0-0000-7000-8000-000000000002';

const confirmed = (productId = P1): CompanyMapping => ({ productId, status: 'confirmed' });
const proposed = (productId = P2): CompanyMapping => ({ productId, status: 'proposed' });

describe('a TAC is exactly eight digits', () => {
  it('accepts eight', () => {
    expect(isValidTac('35693803')).toBe(true);
  });

  it('rejects seven, nine, and anything non-numeric', () => {
    for (const bad of ['3569380', '356938031', '3569380A', '', '  35693803  ']) {
      expect(isValidTac(bad)).toBe(false);
    }
  });

  it('takes the TAC from a 15-digit IMEI, and nothing else', () => {
    expect(tacFromImei('356938035643809')).toBe('35693803');
    expect(tacFromImei('35693803564380')).toBeNull();
    expect(tacFromImei('not-an-imei')).toBeNull();
  });

  it('an invalid TAC resolves to unknown rather than throwing', () => {
    const out = resolveTac({ tac: 'nope', companyMappings: [confirmed()], globalEntry: GLOBAL });
    expect(out.source).toBe('none');
    expect(out.productId).toBeNull();
  });
});

describe('the ladder, in order', () => {
  it('1 — a confirmed company mapping returns that company’s exact product', () => {
    const out = resolveTac({ tac: '35693803', companyMappings: [confirmed()], globalEntry: GLOBAL });
    expect(out.source).toBe('company_confirmed');
    expect(out.productId).toBe(P1);
    expect(out.needsReview).toBe(false);
  });

  /**
   * The rule that keeps an Employee's suggestion from becoming a decision. The
   * product id is deliberately null: the surest way to guarantee a proposal is
   * never auto-selected is to give the caller nothing to select.
   */
  it('2 — a pending proposal is shown, flagged, and NEVER auto-selected', () => {
    const out = resolveTac({ tac: '35693803', companyMappings: [proposed()], globalEntry: GLOBAL });
    expect(out.source).toBe('company_proposed');
    expect(out.productId).toBeNull();
    expect(out.needsReview).toBe(true);
    expect(out.reviewReason).toBe('unconfirmed_proposal');
  });

  it('3 — with no company mapping, the global catalogue gives brand and model only', () => {
    const out = resolveTac({ tac: '35693803', companyMappings: [], globalEntry: GLOBAL });
    expect(out.source).toBe('global_catalog');
    expect(out.brand).toBe('Samsung');
    expect(out.model).toBe('Galaxy A14');
    // The global layer has no product to point at, and never gains one.
    expect(out.productId).toBeNull();
  });

  it('4 — with no evidence at all, unknown', () => {
    const out = resolveTac({ tac: '35693803', companyMappings: [], globalEntry: null });
    expect(out.source).toBe('none');
    expect(out.productId).toBeNull();
    expect(out.needsReview).toBe(false);
  });

  it('a confirmed mapping OUTRANKS the global catalogue', () => {
    const out = resolveTac({ tac: '35693803', companyMappings: [confirmed()], globalEntry: GLOBAL });
    expect(out.source).toBe('company_confirmed');
    expect(out.productId).toBe(P1);
  });

  it('a confirmed mapping outranks a proposal for the same TAC', () => {
    const out = resolveTac({
      tac: '35693803',
      companyMappings: [proposed(P2), confirmed(P1)],
      globalEntry: GLOBAL,
    });
    expect(out.productId).toBe(P1);
    expect(out.needsReview).toBe(false);
  });

  it('a superseded mapping counts for nothing', () => {
    const out = resolveTac({
      tac: '35693803',
      companyMappings: [{ productId: P1, status: 'superseded' }],
      globalEntry: null,
    });
    expect(out.source).toBe('none');
  });
});

describe('rule 7 — exact evidence is never weakened by a score', () => {
  it('a low confidence does not demote a confirmed mapping', () => {
    const out = resolveTac({
      tac: '35693803',
      companyMappings: [{ productId: P1, status: 'confirmed', confidence: 0.01 }],
      globalEntry: GLOBAL,
    });
    // Confirmed is confirmed. Confidence is reported elsewhere, never used to
    // outrank somebody's explicit decision.
    expect(out.source).toBe('company_confirmed');
    expect(out.productId).toBe(P1);
  });
});

describe('rule 5 — nothing beyond identity is ever inferred', () => {
  it('returns no storage, colour, condition, cost or price', () => {
    for (const mappings of [[confirmed()], [proposed()], []]) {
      const out = resolveTac({ tac: '35693803', companyMappings: mappings, globalEntry: GLOBAL });
      for (const forbidden of ['storage', 'colour', 'color', 'condition', 'cost', 'price']) {
        expect(Object.keys(out)).not.toContain(forbidden);
      }
    }
  });
});

describe('rule 6 — conflict requires review, never a silent pick', () => {
  it('two confirmed mappings stop and ask', () => {
    // The database refuses this; if it ever happened, guessing would be worse
    // than saying so.
    const out = resolveTac({
      tac: '35693803',
      companyMappings: [confirmed(P1), confirmed(P2)],
      globalEntry: GLOBAL,
    });
    expect(out.needsReview).toBe(true);
    expect(out.reviewReason).toBe('conflicting_mappings');
    expect(out.productId).toBeNull();
  });
});

describe('one product, several TACs — and one TAC per company', () => {
  it('several TACs may resolve to the same product', () => {
    for (const tac of ['35693803', '49015420', '01397100']) {
      expect(resolveTac({ tac, companyMappings: [confirmed(P1)], globalEntry: null }).productId).toBe(P1);
    }
  });

  it('the same TAC resolves independently per company', () => {
    // Each company's own mapping set is passed in; there is no shared state
    // here, and the service reads through the tenant client.
    const a = resolveTac({ tac: '35693803', companyMappings: [confirmed(P1)], globalEntry: GLOBAL });
    const b = resolveTac({ tac: '35693803', companyMappings: [confirmed(P2)], globalEntry: GLOBAL });
    expect(a.productId).toBe(P1);
    expect(b.productId).toBe(P2);
  });

  it('one company having no mapping does not inherit another’s', () => {
    const out = resolveTac({ tac: '35693803', companyMappings: [], globalEntry: GLOBAL });
    expect(out.productId).toBeNull();
    expect(out.source).toBe('global_catalog');
  });
});

describe('dual-SIM — two TACs, one phone', () => {
  const conf = (p: string) => resolveTac({ tac: '35693803', companyMappings: [confirmed(p)], globalEntry: null });
  const none = resolveTac({ tac: '49015420', companyMappings: [], globalEntry: null });

  it('both resolving to the SAME product is one strong suggestion', () => {
    const out = reconcileDualSim(conf(P1), conf(P1));
    expect(out.productId).toBe(P1);
    expect(out.needsReview).toBe(false);
  });

  it('only one resolving still gives that evidence', () => {
    expect(reconcileDualSim(conf(P1), none).productId).toBe(P1);
    expect(reconcileDualSim(none, conf(P1)).productId).toBe(P1);
  });

  /**
   * Two TACs naming different products means the read is wrong, the phone is
   * unusual, or the mappings are. Picking one would create an inventory record
   * for a device that does not exist.
   */
  it('CONFLICTING products block automatic selection', () => {
    const out = reconcileDualSim(conf(P1), conf(P2));
    expect(out.needsReview).toBe(true);
    expect(out.reviewReason).toBe('conflicting_mappings');
    expect(out.productId).toBeNull();
  });

  it('a single-SIM phone is unaffected', () => {
    expect(reconcileDualSim(conf(P1), null).productId).toBe(P1);
  });

  it('neither resolving stays unknown', () => {
    expect(reconcileDualSim(none, none).productId).toBeNull();
  });
});

describe('permissions and the two layers', () => {
  const service = readFileSync(join(__dirname, 'tac-mapping.service.ts'), 'utf8');
  const code = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('both routes need unit.add, which gates receiving', () => {
    expect(Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, TacMappingController.prototype.resolve)).toEqual([
      'unit.add',
    ]);
    expect(Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, TacMappingController.prototype.submit)).toEqual([
      'unit.add',
    ]);
  });

  it('confirming is gated on catalog.manage, which an Employee does not hold', () => {
    expect(code).toMatch(/canConfirm\(\)[\s\S]{0,120}catalog\.manage/);
    expect(ROLE_PERMISSIONS.store_employee).toContain('unit.add');
    expect(ROLE_PERMISSIONS.store_employee).not.toContain('catalog.manage');
    expect(ROLE_PERMISSIONS.store_manager).toContain('catalog.manage');
    expect(ROLE_PERMISSIONS.owner).toContain('catalog.manage');
  });

  /**
   * The decision that the whole feature rests on. A store user's confirmation
   * must never reach the globally shared catalogue, because it is shared: one
   * shop's naming would rename that TAC for every other company.
   */
  it('NOTHING writes to the global tac_catalog', () => {
    expect(code).not.toMatch(/tacCatalog\.(create|update|upsert|delete|updateMany)/);
    // Reading it for generic identity is fine, and is all that happens.
    expect(code).toMatch(/tacCatalog\.(findUnique|findFirst)/);
  });

  it('refuses to read synthetic fixture mappings outside staging', () => {
    /*
     * The retained test shop maps twenty synthetic TACs to iPhones so the
     * recognition ladder can be exercised end to end. If those rows ever
     * travelled — a dump restored into the wrong place, a copied database —
     * they must not become suggestions somebody acts on. The guard sits at the
     * READ, not only in the command that writes them, because the command is
     * not what a stray database has already run.
     */
    expect(code).toMatch(/isStagingEnvironment\(\)/);
    expect(code).toMatch(/source: \{ not: 'synthetic_staging' \}/);
    // And only active mappings are ever read.
    expect(code).toMatch(/isActive: true/);
  });

  it('a product is looked up through the TENANT client, so another company’s is a 404', () => {
    expect(code).toMatch(/this\.db\.product\.findFirst/);
    expect(code).toMatch(/NotFoundException\('Product not found'\)/);
  });

  it('a malformed product id is a 404, not a 500', () => {
    expect(code).toMatch(/isUuid\(dto\.productId\)/);
  });

  it('replacing a confirmation is guarded on version, so one manager wins', () => {
    expect(code).toMatch(/version: dto\.expectedVersion/);
    expect(code).toMatch(/refresh_required/);
  });

  it('the replaced mapping is superseded, never deleted', () => {
    expect(code).toMatch(/status: 'superseded'/);
    expect(code).not.toMatch(/\.delete\(|deleteMany/);
  });

  it('an Employee cannot overwrite an existing confirmation', () => {
    expect(code).toMatch(/already_confirmed/);
  });

  it('resolve() returns only CONFIRMED mappings as authoritative', () => {
    const recognition = readFileSync(join(__dirname, 'recognition.service.ts'), 'utf8');
    const fn = recognition.slice(
      recognition.indexOf('async resolve('),
      recognition.indexOf('async mappingsForCode('),
    );
    expect(fn).toMatch(/status: 'confirmed'/);
  });
});
