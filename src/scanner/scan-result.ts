import { CodeType } from '@prisma/client';
import { ProductSuggestion } from '../catalog/catalog.service';
import { ScanKind } from './code-classifier';

/** The single response shape for POST /scan, for every identifier kind. */
export interface ScanResult {
  /** Normalized code. */
  code: string;
  kind: ScanKind;
  recognized: boolean;
  /** 0..1 confidence in the suggestion (0 when not recognized). */
  confidence: number;
  /** Learning-map key for this code, so a later confirm can teach it. */
  recognitionKey: { codeType: CodeType; code: string } | null;
  suggestion: ProductSuggestion | null;
  /**
   * Whether this identifier is ALREADY a phone in inventory.
   *
   * Deliberately separate from `recognized`, which they were previously
   * conflated with on the client. They answer different questions and are
   * routinely different answers:
   *
   *   recognized  — "I know what product this TAC belongs to"  (a catalogue fact)
   *   inventory   — "I already hold this exact handset"        (a stock fact)
   *
   * Every iPhone 15 in the world shares a TAC, so `recognized` is true for a
   * phone that has never been near this shop. Treating that as "already in
   * inventory" would refuse every second handset of a model; treating stock as
   * recognition would offer to create a duplicate.
   *
   * Present only for per-unit identifiers. A barcode names a reusable product,
   * not a physical thing, so asking whether it is "already in inventory" is not
   * a question — it stays `null`.
   */
  inventory: ScanInventoryMatch | null;
  /** Short guidance when not recognized (client shows create/confirm prompt). */
  hint?: string;
}

/**
 * What the server knows about this identifier already existing.
 *
 * The privacy rule is in the shape: `unit` is populated ONLY for a unit the
 * caller can actually reach. Everything else resolves to `elsewhere`, which
 * carries a boolean and nothing that could name another shop, its branch, its
 * product, its staff or its money.
 */
export interface ScanInventoryMatch {
  alreadyInInventory: boolean;
  /** Which column matched, when the match is one the caller may see. */
  matchedIdentifierPosition: 'primary' | 'secondary' | null;
  /** Safe summary. Never a cost, a margin, or an internal id. */
  unit: { productLabel: string; branchName: string; status: string } | null;
  /**
   * Taken by a unit outside this caller's company or assigned branches.
   *
   * Intake must still be refused — IMEI uniqueness in this database is global,
   * so the insert would fail anyway — but nothing may be said about whose it
   * is. Saying so early costs exactly the information the insert trigger would
   * have revealed a minute later, and saves the typing in between.
   */
  elsewhere: boolean;
  /** Two identifiers resolved to two DIFFERENT units. Never one phone. */
  conflictingUnits: boolean;
}
