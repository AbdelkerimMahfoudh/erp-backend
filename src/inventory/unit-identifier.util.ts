/**
 * A unit's universal identifier = its IMEI or its serial (mirrors the DB
 * generated `identifier = COALESCE(imei_primary, serial_no)`). Prisma cannot
 * expose the generated column, so we compute the same value in code.
 */
export function unitIdentifier(u: { imeiPrimary: string | null; serialNo: string | null }): string {
  return u.imeiPrimary ?? u.serialNo ?? '';
}
