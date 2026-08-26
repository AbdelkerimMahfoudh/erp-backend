import { ROLE_PERMISSIONS, type RoleKey } from './role-permissions';
import { DEFAULT_TENANT_ROLE_KEYS } from './role-provisioning';

/**
 * Deciding whether a company may be repaired.
 *
 * Pure, and separate from the command that uses it, because this is the part
 * that must be right. A false positive here silently rewrites a real shop's
 * access — which would be a worse bug than the empty roles being repaired, and
 * a quieter one.
 *
 * So the rule is not "does it look broken" but "is it provably the untouched
 * empty case". Anything partial, customised or unrecognised is skipped whole
 * and reported for a person to look at. Nothing here completes, normalises or
 * replaces an existing mapping.
 */

/** The demo company's fixed id. Correctly seeded; never a repair target. */
export const DEMO_COMPANY_UUID = '018f0000-0000-7000-8000-000000000001';

export interface RoleSnapshot {
  key: string;
  mappingCount: number;
}

export interface CompanySnapshot {
  /** The company's UUID, as text. */
  uuid: string;
  /** Whether a `registration_attempts` row names this company. */
  cameFromSelfRegistration: boolean;
  roles: RoleSnapshot[];
}

export type Verdict =
  | { kind: 'eligible'; willAdd: Record<string, number> }
  | { kind: 'skip'; why: string };

const DEFAULTS = [...DEFAULT_TENANT_ROLE_KEYS].sort();

export function judgeCompany(company: CompanySnapshot): Verdict {
  // The demo tenant is seeded correctly and is not a registration artefact.
  // Checked first, so no later rule can ever reach it.
  if (company.uuid === DEMO_COMPANY_UUID) {
    return { kind: 'skip', why: 'the demo tenant — correctly seeded, never touched' };
  }

  /*
   * Provenance, not shape.
   *
   * Only companies that came through the affected self-registration path are in
   * scope. A company created another way that happens to have empty roles is
   * somebody else's situation, and guessing at it is not repair.
   */
  if (!company.cameFromSelfRegistration) {
    return {
      kind: 'skip',
      why: 'no registration provenance: it did not come through self-registration',
    };
  }

  const keys = company.roles.map((r) => r.key).sort();
  if (keys.length !== DEFAULTS.length || keys.some((k, i) => k !== DEFAULTS[i])) {
    return {
      kind: 'skip',
      why: `role keys are [${keys.join(', ') || 'none'}], not exactly the three defaults`,
    };
  }

  /*
   * ALL three must be empty.
   *
   * One role carrying mappings means somebody configured this company — either
   * deliberately, or through a path this repair does not understand. Filling in
   * "the missing ones" would be inventing a decision, so the whole company is
   * skipped rather than partly written.
   */
  const configured = company.roles.filter((r) => r.mappingCount > 0);
  if (configured.length > 0) {
    const detail = configured.map((r) => `${r.key}(${r.mappingCount})`).join(', ');

    /*
     * Already correct is a different answer from already customised, and
     * saying so matters: an operator re-running the repair should be able to
     * see at a glance that the previous run worked, rather than reading four
     * lines that sound like unresolved problems needing manual review.
     */
    const isCanonical =
      configured.length === company.roles.length &&
      company.roles.every(
        (r) => r.mappingCount === ROLE_PERMISSIONS[r.key as RoleKey]?.length,
      );
    if (isCanonical) {
      return { kind: 'skip', why: `already provisioned with the canonical matrix — ${detail}` };
    }

    return {
      kind: 'skip',
      why: `already has permissions on ${detail} — partial or customised, left for manual review`,
    };
  }

  const willAdd: Record<string, number> = {};
  for (const key of DEFAULT_TENANT_ROLE_KEYS) {
    willAdd[key] = ROLE_PERMISSIONS[key as RoleKey].length;
  }
  return { kind: 'eligible', willAdd };
}
