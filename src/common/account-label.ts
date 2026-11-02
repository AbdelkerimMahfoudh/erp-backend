/**
 * What to call an account (D227). `companies.name` is an optional registered or trading name, and most shops have none.
 * Nothing here is stored as a company name, and none of it is the Owner's personal name as a shop's identity.
 *
 * The rules, in order:
 *  1. something about one store (a consignment, a loan, an invitation) names that store, whatever else is set;
 *  2. something about the whole account says so in neutral words ({@link neutralAccount});
 *  3. after sign-in, a person chooses among the stores they can reach ({@link storesOfUser}), never a made-up parent;
 *  4. a connection joins whole accounts, so it shows the account: {@link accountView}.
 */

export interface NamedStore {
  name: string;
  nameAr: string | null;
}

/**
 * Every active store of an account, in an explicit, stable order. A connection joins whole accounts: this order decides
 * only which name a compact label shows first. That store did not "participate" in anything, and is never said to.
 */
export const ACTIVE_STORES = {
  branches: {
    where: { isActive: true },
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    select: { name: true, nameAr: true },
  },
};

/**
 * `Boutique Centre (+2)`: one string for a field a build up to 1.0.0 (3) reads whole. Locale-neutral, because the server
 * cannot know that reader's language; new clients word it themselves from the list. `leading` is a store a search matched.
 */
export function compactStores(stores: readonly NamedStore[], arabic = false, leading?: NamedStore): string {
  const first = leading ?? stores[0];
  if (!first) return '';
  const name = arabic ? (first.nameAr ?? first.name) : first.name;
  return stores.length > 1 ? `${name} (+${stores.length - 1})` : name;
}

/** The store a name search matched: the one it should lead with, rather than an unrelated oldest one. */
export function matchedStore(stores: readonly NamedStore[], query: string | undefined): NamedStore | undefined {
  const q = query?.trim().toLocaleLowerCase();
  if (!q) return undefined;
  return stores.find((s) => s.name.toLocaleLowerCase().startsWith(q) || s.nameAr?.toLocaleLowerCase().startsWith(q));
}

/** An account as another account reads it: account-level, its name in one string for older builds. */
export function accountView(account: { name: string | null; nameAr?: string | null; branches?: NamedStore[] }, query?: string) {
  const stores = account.branches ?? [];
  const leading = matchedStore(stores, query);
  return {
    name: account.name || compactStores(stores, false, leading),
    nameAr: account.name ? (account.nameAr ?? null) : stores.length ? compactStores(stores, true, leading) : null,
  };
}

/** A record's exact store. A trading name is secondary context, sent beside it, and never replaces it. */
export function participantLabel(account: { name: string | null }, store: { name: string } | null | undefined): string {
  return store?.name || account.name || '';
}

export function participantLabelAr(account: { name: string | null; nameAr?: string | null }, store: { nameAr: string | null } | null | undefined): string | null {
  return store ? store.nameAr : (account.nameAr ?? null);
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
