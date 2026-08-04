/**
 * Parse a short duration string ("900s", "15m", "1h", "30d", or a bare number of
 * seconds) into seconds. Used to report token TTLs to clients.
 */
export function parseDurationSeconds(value: string): number {
  const match = /^(\d+)\s*(s|m|h|d)?$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid duration: "${value}"`);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? 's';
  const factor: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return amount * factor[unit];
}
