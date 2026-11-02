/**
 * What to call an account (D227). `companies.name` is an optional registered or trading name, and most shops have none.
 * Nothing here is stored as a company name, and none of it is the Owner's personal name as a shop's identity.
 *
 * The rules, in order:
 *  1. something about one store (a consignment, a loan, an invitation) names that store;
 *  2. something about the whole account says so in neutral words ({@link neutralAccount});
 *  3. after sign-in, a person chooses among the stores they can reach ({@link storesOfUser}), never a made-up parent;
 *  4. only a connection, which records no store at all, falls back to {@link LEGACY_OLDEST_STORE}.
 */

export interface NamedStore {
  name: string;
  nameAr: string | null;
}

/**
 * LEGACY ONLY: a connection is between two accounts and records no participating store, and the app has no designated
 * primary store. So the other side of a connection is its oldest active store, in an explicit, stable order. Not for
 * anything that knows its store. `source-scan` in the spec pins where this may be used.
 */
export const LEGACY_OLDEST_STORE = {
  branches: {
    where: { isActive: true },
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    take: 1,
    select: { name: true, nameAr: true },
  },
};

export interface LegacyLabelled {
  name: string | null;
  nameAr?: string | null;
  branches?: NamedStore[];
}

export function legacyLabel(account: LegacyLabelled | null | undefined): string {
  return account?.name || account?.branches?.[0]?.name || '';
}

export function legacyLabelAr(account: LegacyLabelled | null | undefined): string | null {
  // A trading name with no Arabic twin is shown as it is, never replaced by a store's.
  if (account?.name) return account.nameAr ?? null;
  return account?.nameAr || account?.branches?.[0]?.nameAr || null;
}

/** One party to something that knows its store: the trading name when there is one, otherwise that exact store. */
export function participantLabel(account: { name: string | null }, store: { name: string } | null | undefined): string {
  return account.name || store?.name || '';
}

export function participantLabelAr(account: { name: string | null; nameAr?: string | null }, store: { nameAr: string | null } | null | undefined): string | null {
  if (account.name) return account.nameAr ?? null;
  return account.nameAr || store?.nameAr || null;
}

const NEUTRAL: Record<'en' | 'fr' | 'ar', string> = {
  en: 'your Dukan account',
  fr: 'votre compte Dukan',
  ar: 'حسابك في دكان',
};

/** An account-wide message with no trading name to use. Never an arbitrary store. */
export function neutralAccount(language: 'en' | 'fr' | 'ar', startsSentence = false): string {
  const words = NEUTRAL[language];
  return startsSentence ? words.charAt(0).toUpperCase() + words.slice(1) : words;
}

interface StoreReader {
  userBranch: {
    findMany(args: {
      where: { userId: Buffer; branch: { isActive: boolean } };
      orderBy: { id: 'asc' }[];
      select: { branch: { select: { name: true; nameAr: true } } };
    }): Promise<{ branch: NamedStore }[]>;
  };
}

/** The stores this person holds, in the order they were assigned: an assignment's id is time-ordered. */
export async function storesOfUser(db: StoreReader, userId: Buffer): Promise<NamedStore[]> {
  const rows = await db.userBranch.findMany({
    where: { userId, branch: { isActive: true } },
    orderBy: [{ id: 'asc' }],
    select: { branch: { select: { name: true, nameAr: true } } },
  });
  return rows.map((r) => r.branch);
}

/** Stores written out for a field an older build reads as one string. A list of them, never a parent's name. */
export function storesText(stores: readonly NamedStore[]): string {
  return stores.map((s) => s.name).join(', ');
}

export function storesTextAr(stores: readonly NamedStore[]): string | null {
  return stores.some((s) => s.nameAr) ? stores.map((s) => s.nameAr ?? s.name).join('، ') : null;
}

/** The console's parts of an account with no trading name. It words them itself, in the operator's language. */
export function adminAccountLabel(owner: string | null, stores: readonly { name: string }[]): { owner: string | null; store: string | null; moreStores: number } {
  return { owner, store: stores[0]?.name ?? null, moreStores: Math.max(0, stores.length - 1) };
}
