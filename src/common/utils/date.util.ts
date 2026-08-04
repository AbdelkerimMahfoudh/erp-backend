/** UTC day key (YYYY-MM-DD) — the branch-day bucket for rollups/closing. */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
