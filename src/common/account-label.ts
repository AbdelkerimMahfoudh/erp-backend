/**
 * What to call an account (D227). `companies.name` is an optional registered or trading name: most shops have none. Where
 * a person must read a name, a shop without one is known by its first store. This is presentation only: it is never
 * stored as a company name, and it is never the Owner's personal name.
 */
export const FIRST_STORE = {
  branches: {
    where: { isActive: true },
    orderBy: { createdAt: 'asc' as const },
    take: 1,
    select: { name: true, nameAr: true },
  },
};

export interface LabelledAccount {
  name: string | null;
  nameAr?: string | null;
  branches?: { name: string; nameAr: string | null }[];
}

export function labelOf(account: LabelledAccount | null | undefined): string {
  return account?.name || account?.branches?.[0]?.name || '';
}

export function labelArOf(account: LabelledAccount | null | undefined): string | null {
  // A trading name with no Arabic twin is shown as it is, never replaced by a store's.
  if (account?.name) return account.nameAr ?? null;
  return account?.nameAr || account?.branches?.[0]?.nameAr || null;
}

/** For one account by id, on any client that can read `companies`. */
export async function accountLabel(
  db: { company: { findUnique(args: { where: { id: Buffer }; select: Record<string, unknown> }): Promise<unknown> } },
  id: Buffer,
): Promise<string> {
  const row = (await db.company.findUnique({ where: { id }, select: { name: true, ...FIRST_STORE } })) as LabelledAccount | null;
  return labelOf(row);
}
