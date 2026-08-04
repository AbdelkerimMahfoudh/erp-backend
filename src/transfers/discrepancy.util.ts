/** Receiving discrepancy report (WF15 / req 3): expected vs scanned IMEIs. */
export interface DiscrepancyReport {
  expected: string[];
  scanned: string[]; // de-duplicated
  matched: string[];
  missing: string[]; // expected but not scanned
  unexpected: string[]; // scanned but not expected
  duplicate: string[]; // scanned more than once
  hasDiscrepancy: boolean;
}

export function computeDiscrepancy(expected: string[], scannedRaw: string[]): DiscrepancyReport {
  const expectedSet = new Set(expected);
  const counts = new Map<string, number>();
  for (const s of scannedRaw) counts.set(s, (counts.get(s) ?? 0) + 1);

  const scanned = [...counts.keys()];
  const duplicate = [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  const missing = expected.filter((e) => !counts.has(e));
  const unexpected = scanned.filter((s) => !expectedSet.has(s));
  const matched = expected.filter((e) => counts.has(e));

  return {
    expected,
    scanned,
    matched,
    missing,
    unexpected,
    duplicate,
    hasDiscrepancy: missing.length > 0 || unexpected.length > 0 || duplicate.length > 0,
  };
}
