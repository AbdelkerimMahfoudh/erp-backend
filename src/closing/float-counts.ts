/**
 * The provider floats at the closing of an agent branch (D154, docs/73 §4.5), pure.
 *
 * A combined branch counts the drawer, the receiving-account channels AND the
 * floats in the one closing; an agent-only branch counts the drawer and the
 * floats. Which floats the closing lists, which of them still stand between
 * the day and its lock, and what a count's difference is, are rules — so they
 * live here, beside `channels.ts`, and the service only reads and writes.
 */

export interface FloatProviderRow {
  providerId: string;
  label: string;
  isActive: boolean;
}

export interface FloatCountState {
  providerId: string;
  counted: number | null;
  isSkipped: boolean;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** counted − expected, only when both are known: an unknown float is never read as zero, and no difference is invented. */
export function floatDifference(expected: number | null, counted: number | null): number | null {
  return expected === null || counted === null ? null : round2(counted - expected);
}

/**
 * Which floats the closing lists: every active provider — switched on, it is
 * owed a count whether or not it moved today — and any provider somebody
 * already counted or skipped at this closing, however it stands now.
 */
export function listedFloats<P extends FloatProviderRow>(providers: readonly P[], counts: ReadonlyMap<string, FloatCountState>): P[] {
  return providers.filter((p) => p.isActive || counts.has(p.providerId));
}

/**
 * The floats a lock still waits for: an ACTIVE provider with neither a count
 * nor a recorded skip. Silence is not a state (as for a channel): a float
 * nobody looked at is outstanding, not agreed. Empty for an electronics-only
 * branch, which lists no float at all.
 */
export function floatsToCount<P extends FloatProviderRow>(providers: readonly P[], counts: ReadonlyMap<string, FloatCountState>): P[] {
  return providers.filter((p) => {
    if (!p.isActive) return false;
    const c = counts.get(p.providerId);
    return !c || (c.counted === null && !c.isSkipped);
  });
}
