/**
 * The device catalogue: the phone brands and models a shop can pick from.
 *
 * ## Why this is a starter catalogue, and says so
 *
 * This is **curated reference data, not an authoritative device database.** It
 * covers the brands and model families actually traded in this market and the
 * generations still moving second-hand. It is deliberately NOT every regional
 * SKU, and it never claims to be: a shopkeeper who cannot find their exact
 * handset types the name in, and that path is a first-class outcome rather than
 * a failure — see `Other brand` and `Other model` in the selectors.
 *
 * Broad, reliable production coverage — every SKU, every region, every TAC —
 * needs **licensed GSMA data**. That is a commercial arrangement, not a
 * scraping job, and nothing here pretends otherwise.
 *
 * ## What a model is, and is not
 *
 * A model is a commercial name. Storage, colour, cosmetic condition and an
 * individual IMEI are **not** models: the product schema already carries
 * `variant` for storage and colour, and the unit carries the identifier. Baking
 * "128 GB Black" into a model name would make the catalogue unsearchable and
 * the reporting meaningless.
 *
 * ## Ordering: the list order IS the display order
 *
 * Each brand's array is written in the order a shopkeeper should see it —
 * newest family first, and within a family the premium variant first: Pro Max,
 * Pro, Air/Plus, standard, then value variants (`e`, mini, SE). Samsung reads
 * Ultra, Plus, standard, FE, and the other brands follow their own line.
 *
 * `displayRank` is derived from that position, so **correcting the order means
 * moving a line** rather than recomputing numbers by hand.
 *
 * Release year was doing this job and could not. It is one fact and the order
 * is another, and they genuinely conflict: `iPhone 17e` shipped in 2026 and
 * belongs BELOW `iPhone 17 Pro Max` from 2025, because it is the value variant
 * of the same family. Sorting by year also fell back to alphabetical, which put
 * `iPhone 16e` above `iPhone 17`. Both are now impossible.
 *
 * `releaseRank` stays exactly what it says — the year — and stays separately
 * queryable, because a phone's release year is real curated data and
 * re-deriving it later would mean curating 323 rows again.
 *
 * ## Provenance
 *
 * `CATALOGUE_SOURCE` and `CATALOGUE_REVIEWED_ON` travel with every row. The
 * source is `curated` — assembled from manufacturer product lines and reviewed
 * on the date below — and NOT `official`, which is reserved for rows taken from
 * a licensed feed. Saying `official` here would be a claim nobody could check.
 *
 * This file is the single source of truth. Migration `0062` inserts a snapshot
 * of it, and `device-catalogue.spec.ts` fails the build if the two drift.
 */

export const CATALOGUE_SOURCE = 'curated' as const;
export const CATALOGUE_REVIEWED_ON = '2026-08-30';

export interface CatalogueBrand {
  /** Stable key. Never displayed, never changes, safe to reference. */
  key: string;
  /** What people call it. */
  name: string;
  /** Also matched when searching, case- and accent-insensitively. */
  aliases: string[];
  /** Lower sorts first. Grouped by how often this market sees them. */
  order: number;
  /**
   * Who actually manufactures it, when that differs from the storefront brand.
   *
   * Redmi and POCO are Xiaomi's, and recording that is useful internally — but
   * they are searched, displayed and sold as brands in their own right, because
   * that is how they are sold in the shop. The relationship is a note, not a
   * hierarchy the picker imposes on anybody.
   */
  parentKey?: string;
}

export interface CatalogueModel {
  brandKey: string;
  /** The canonical commercial name, in the manufacturer's own spelling. */
  name: string;
  /** The series it belongs to, for grouping and for search. */
  family: string;
  /** Release year. A fact about the phone, not the display order. */
  releaseRank: number;
  /** Regional names and common shorthands. */
  aliases?: string[];
}

/** A model with its position resolved. What the database and the API carry. */
export interface RankedCatalogueModel extends CatalogueModel {
  /** Higher sorts first. Derived from the model's position in its brand list. */
  displayRank: number;
}

/**
 * `other` is a real row, not a special case in the UI.
 *
 * It sorts last, it is always present, and choosing it reveals a free-text
 * field. Making it a catalogue row rather than a magic string means the
 * selector has no branch for "the thing that is not in the list".
 */
export const BRANDS: readonly CatalogueBrand[] = [
  { key: 'apple', name: 'Apple', aliases: ['iphone'], order: 1 },
  { key: 'samsung', name: 'Samsung', aliases: ['galaxy'], order: 2 },
  { key: 'xiaomi', name: 'Xiaomi', aliases: ['mi'], order: 3 },
  { key: 'redmi', name: 'Redmi', aliases: [], order: 4, parentKey: 'xiaomi' },
  { key: 'poco', name: 'POCO', aliases: ['pocophone'], order: 5, parentKey: 'xiaomi' },
  { key: 'tecno', name: 'Tecno', aliases: ['tecno mobile'], order: 6 },
  { key: 'infinix', name: 'Infinix', aliases: [], order: 7 },
  { key: 'itel', name: 'itel', aliases: ['itel mobile'], order: 8 },
  { key: 'oppo', name: 'OPPO', aliases: [], order: 9 },
  { key: 'realme', name: 'realme', aliases: [], order: 10 },
  { key: 'huawei', name: 'Huawei', aliases: [], order: 11 },
  { key: 'honor', name: 'Honor', aliases: [], order: 12 },
  { key: 'other', name: 'Other brand', aliases: ['unknown', 'autre', 'أخرى'], order: 999 },
];

const apple: CatalogueModel[] = [
  { brandKey: 'apple', name: 'iPhone 17 Pro Max', family: 'iPhone 17', releaseRank: 2025 },
  { brandKey: 'apple', name: 'iPhone 17 Pro', family: 'iPhone 17', releaseRank: 2025 },
  { brandKey: 'apple', name: 'iPhone Air', family: 'iPhone Air', releaseRank: 2025 },
  { brandKey: 'apple', name: 'iPhone 17', family: 'iPhone 17', releaseRank: 2025 },
  { brandKey: 'apple', name: 'iPhone 17e', family: 'iPhone 17', releaseRank: 2026 },
  { brandKey: 'apple', name: 'iPhone 16 Pro Max', family: 'iPhone 16', releaseRank: 2024 },
  { brandKey: 'apple', name: 'iPhone 16 Pro', family: 'iPhone 16', releaseRank: 2024 },
  { brandKey: 'apple', name: 'iPhone 16 Plus', family: 'iPhone 16', releaseRank: 2024 },
  { brandKey: 'apple', name: 'iPhone 16', family: 'iPhone 16', releaseRank: 2024 },
  { brandKey: 'apple', name: 'iPhone 16e', family: 'iPhone 16', releaseRank: 2025 },
  { brandKey: 'apple', name: 'iPhone 15 Pro Max', family: 'iPhone 15', releaseRank: 2023 },
  { brandKey: 'apple', name: 'iPhone 15 Pro', family: 'iPhone 15', releaseRank: 2023 },
  { brandKey: 'apple', name: 'iPhone 15 Plus', family: 'iPhone 15', releaseRank: 2023 },
  { brandKey: 'apple', name: 'iPhone 15', family: 'iPhone 15', releaseRank: 2023 },
  { brandKey: 'apple', name: 'iPhone 14 Pro Max', family: 'iPhone 14', releaseRank: 2022 },
  { brandKey: 'apple', name: 'iPhone 14 Pro', family: 'iPhone 14', releaseRank: 2022 },
  { brandKey: 'apple', name: 'iPhone 14 Plus', family: 'iPhone 14', releaseRank: 2022 },
  { brandKey: 'apple', name: 'iPhone 14', family: 'iPhone 14', releaseRank: 2022 },
  { brandKey: 'apple', name: 'iPhone 13 Pro Max', family: 'iPhone 13', releaseRank: 2021 },
  { brandKey: 'apple', name: 'iPhone 13 Pro', family: 'iPhone 13', releaseRank: 2021 },
  { brandKey: 'apple', name: 'iPhone 13', family: 'iPhone 13', releaseRank: 2021 },
  { brandKey: 'apple', name: 'iPhone 13 mini', family: 'iPhone 13', releaseRank: 2021 },
  { brandKey: 'apple', name: 'iPhone 12 Pro Max', family: 'iPhone 12', releaseRank: 2020 },
  { brandKey: 'apple', name: 'iPhone 12 Pro', family: 'iPhone 12', releaseRank: 2020 },
  { brandKey: 'apple', name: 'iPhone 12', family: 'iPhone 12', releaseRank: 2020 },
  { brandKey: 'apple', name: 'iPhone 12 mini', family: 'iPhone 12', releaseRank: 2020 },
  { brandKey: 'apple', name: 'iPhone SE (3rd generation)', family: 'iPhone SE', releaseRank: 2022, aliases: ['iphone se 2022', 'se 3'] },
  { brandKey: 'apple', name: 'iPhone 11 Pro Max', family: 'iPhone 11', releaseRank: 2019 },
  { brandKey: 'apple', name: 'iPhone 11 Pro', family: 'iPhone 11', releaseRank: 2019 },
  { brandKey: 'apple', name: 'iPhone 11', family: 'iPhone 11', releaseRank: 2019 },
  { brandKey: 'apple', name: 'iPhone SE (2nd generation)', family: 'iPhone SE', releaseRank: 2020, aliases: ['iphone se 2020', 'se 2'] },
  { brandKey: 'apple', name: 'iPhone XS Max', family: 'iPhone X', releaseRank: 2018 },
  { brandKey: 'apple', name: 'iPhone XS', family: 'iPhone X', releaseRank: 2018 },
  { brandKey: 'apple', name: 'iPhone XR', family: 'iPhone X', releaseRank: 2018 },
  { brandKey: 'apple', name: 'iPhone X', family: 'iPhone X', releaseRank: 2017 },
];

const samsung: CatalogueModel[] = [
  // Galaxy S — the flagship line, newest first.
  { brandKey: 'samsung', name: 'Galaxy S26 Ultra', family: 'Galaxy S', releaseRank: 2026 },
  { brandKey: 'samsung', name: 'Galaxy S26+', family: 'Galaxy S', releaseRank: 2026, aliases: ['galaxy s26 plus'] },
  { brandKey: 'samsung', name: 'Galaxy S26', family: 'Galaxy S', releaseRank: 2026 },
  { brandKey: 'samsung', name: 'Galaxy S25 Ultra', family: 'Galaxy S', releaseRank: 2025 },
  { brandKey: 'samsung', name: 'Galaxy S25+', family: 'Galaxy S', releaseRank: 2025, aliases: ['galaxy s25 plus'] },
  { brandKey: 'samsung', name: 'Galaxy S25', family: 'Galaxy S', releaseRank: 2025 },
  { brandKey: 'samsung', name: 'Galaxy S25 FE', family: 'Galaxy S', releaseRank: 2025 },
  { brandKey: 'samsung', name: 'Galaxy S24 Ultra', family: 'Galaxy S', releaseRank: 2024 },
  { brandKey: 'samsung', name: 'Galaxy S24+', family: 'Galaxy S', releaseRank: 2024, aliases: ['galaxy s24 plus'] },
  { brandKey: 'samsung', name: 'Galaxy S24', family: 'Galaxy S', releaseRank: 2024 },
  { brandKey: 'samsung', name: 'Galaxy S24 FE', family: 'Galaxy S', releaseRank: 2024 },
  { brandKey: 'samsung', name: 'Galaxy S23 Ultra', family: 'Galaxy S', releaseRank: 2023 },
  { brandKey: 'samsung', name: 'Galaxy S23+', family: 'Galaxy S', releaseRank: 2023, aliases: ['galaxy s23 plus'] },
  { brandKey: 'samsung', name: 'Galaxy S23', family: 'Galaxy S', releaseRank: 2023 },
  { brandKey: 'samsung', name: 'Galaxy S23 FE', family: 'Galaxy S', releaseRank: 2023 },
  { brandKey: 'samsung', name: 'Galaxy S22 Ultra', family: 'Galaxy S', releaseRank: 2022 },
  { brandKey: 'samsung', name: 'Galaxy S22+', family: 'Galaxy S', releaseRank: 2022, aliases: ['galaxy s22 plus'] },
  { brandKey: 'samsung', name: 'Galaxy S22', family: 'Galaxy S', releaseRank: 2022 },
  { brandKey: 'samsung', name: 'Galaxy S21 Ultra', family: 'Galaxy S', releaseRank: 2021 },
  { brandKey: 'samsung', name: 'Galaxy S21+', family: 'Galaxy S', releaseRank: 2021, aliases: ['galaxy s21 plus'] },
  { brandKey: 'samsung', name: 'Galaxy S21', family: 'Galaxy S', releaseRank: 2021 },
  { brandKey: 'samsung', name: 'Galaxy S21 FE', family: 'Galaxy S', releaseRank: 2022 },
  // Foldables.
  { brandKey: 'samsung', name: 'Galaxy Z Fold7', family: 'Galaxy Z Fold', releaseRank: 2025 },
  { brandKey: 'samsung', name: 'Galaxy Z Flip7', family: 'Galaxy Z Flip', releaseRank: 2025 },
  { brandKey: 'samsung', name: 'Galaxy Z Fold6', family: 'Galaxy Z Fold', releaseRank: 2024 },
  { brandKey: 'samsung', name: 'Galaxy Z Flip6', family: 'Galaxy Z Flip', releaseRank: 2024 },
  { brandKey: 'samsung', name: 'Galaxy Z Fold5', family: 'Galaxy Z Fold', releaseRank: 2023 },
  { brandKey: 'samsung', name: 'Galaxy Z Flip5', family: 'Galaxy Z Flip', releaseRank: 2023 },
  { brandKey: 'samsung', name: 'Galaxy Z Fold4', family: 'Galaxy Z Fold', releaseRank: 2022 },
  { brandKey: 'samsung', name: 'Galaxy Z Flip4', family: 'Galaxy Z Flip', releaseRank: 2022 },
  { brandKey: 'samsung', name: 'Galaxy Z Fold3', family: 'Galaxy Z Fold', releaseRank: 2021 },
  { brandKey: 'samsung', name: 'Galaxy Z Flip3', family: 'Galaxy Z Flip', releaseRank: 2021 },
  // Galaxy A — the volume line in this market.
  { brandKey: 'samsung', name: 'Galaxy A56', family: 'Galaxy A', releaseRank: 2025 },
  { brandKey: 'samsung', name: 'Galaxy A36', family: 'Galaxy A', releaseRank: 2025 },
  { brandKey: 'samsung', name: 'Galaxy A26', family: 'Galaxy A', releaseRank: 2025 },
  { brandKey: 'samsung', name: 'Galaxy A16', family: 'Galaxy A', releaseRank: 2024 },
  { brandKey: 'samsung', name: 'Galaxy A06', family: 'Galaxy A', releaseRank: 2024 },
  { brandKey: 'samsung', name: 'Galaxy A55', family: 'Galaxy A', releaseRank: 2024 },
  { brandKey: 'samsung', name: 'Galaxy A35', family: 'Galaxy A', releaseRank: 2024 },
  { brandKey: 'samsung', name: 'Galaxy A25', family: 'Galaxy A', releaseRank: 2023 },
  { brandKey: 'samsung', name: 'Galaxy A15', family: 'Galaxy A', releaseRank: 2023 },
  { brandKey: 'samsung', name: 'Galaxy A05', family: 'Galaxy A', releaseRank: 2023 },
  { brandKey: 'samsung', name: 'Galaxy A54', family: 'Galaxy A', releaseRank: 2023 },
  { brandKey: 'samsung', name: 'Galaxy A34', family: 'Galaxy A', releaseRank: 2023 },
  { brandKey: 'samsung', name: 'Galaxy A24', family: 'Galaxy A', releaseRank: 2023 },
  { brandKey: 'samsung', name: 'Galaxy A14', family: 'Galaxy A', releaseRank: 2023 },
  { brandKey: 'samsung', name: 'Galaxy A04', family: 'Galaxy A', releaseRank: 2022 },
  { brandKey: 'samsung', name: 'Galaxy A53', family: 'Galaxy A', releaseRank: 2022 },
  { brandKey: 'samsung', name: 'Galaxy A33', family: 'Galaxy A', releaseRank: 2022 },
  { brandKey: 'samsung', name: 'Galaxy A23', family: 'Galaxy A', releaseRank: 2022 },
  { brandKey: 'samsung', name: 'Galaxy A13', family: 'Galaxy A', releaseRank: 2022 },
  { brandKey: 'samsung', name: 'Galaxy A03', family: 'Galaxy A', releaseRank: 2021 },
  { brandKey: 'samsung', name: 'Galaxy A52', family: 'Galaxy A', releaseRank: 2021 },
  { brandKey: 'samsung', name: 'Galaxy A32', family: 'Galaxy A', releaseRank: 2021 },
  { brandKey: 'samsung', name: 'Galaxy A22', family: 'Galaxy A', releaseRank: 2021 },
  { brandKey: 'samsung', name: 'Galaxy A12', family: 'Galaxy A', releaseRank: 2020 },
  { brandKey: 'samsung', name: 'Galaxy A02', family: 'Galaxy A', releaseRank: 2021 },
  // Galaxy M.
  { brandKey: 'samsung', name: 'Galaxy M55', family: 'Galaxy M', releaseRank: 2024 },
  { brandKey: 'samsung', name: 'Galaxy M35', family: 'Galaxy M', releaseRank: 2024 },
  { brandKey: 'samsung', name: 'Galaxy M15', family: 'Galaxy M', releaseRank: 2024 },
  { brandKey: 'samsung', name: 'Galaxy M14', family: 'Galaxy M', releaseRank: 2023 },
  { brandKey: 'samsung', name: 'Galaxy M13', family: 'Galaxy M', releaseRank: 2022 },
  { brandKey: 'samsung', name: 'Galaxy M12', family: 'Galaxy M', releaseRank: 2021 },
  // Note — second-hand only, but still very much traded.
  { brandKey: 'samsung', name: 'Galaxy Note20 Ultra', family: 'Galaxy Note', releaseRank: 2020 },
  { brandKey: 'samsung', name: 'Galaxy Note20', family: 'Galaxy Note', releaseRank: 2020 },
  { brandKey: 'samsung', name: 'Galaxy Note10+', family: 'Galaxy Note', releaseRank: 2019, aliases: ['note 10 plus'] },
  { brandKey: 'samsung', name: 'Galaxy Note10', family: 'Galaxy Note', releaseRank: 2019 },
];

const xiaomi: CatalogueModel[] = [
  { brandKey: 'xiaomi', name: 'Xiaomi 15 Ultra', family: 'Xiaomi numbered', releaseRank: 2025 },
  { brandKey: 'xiaomi', name: 'Xiaomi 15', family: 'Xiaomi numbered', releaseRank: 2025 },
  { brandKey: 'xiaomi', name: 'Xiaomi 14T Pro', family: 'Xiaomi T', releaseRank: 2024 },
  { brandKey: 'xiaomi', name: 'Xiaomi 14T', family: 'Xiaomi T', releaseRank: 2024 },
  { brandKey: 'xiaomi', name: 'Xiaomi 14 Ultra', family: 'Xiaomi numbered', releaseRank: 2024 },
  { brandKey: 'xiaomi', name: 'Xiaomi 14', family: 'Xiaomi numbered', releaseRank: 2023 },
  { brandKey: 'xiaomi', name: 'Xiaomi 13T Pro', family: 'Xiaomi T', releaseRank: 2023 },
  { brandKey: 'xiaomi', name: 'Xiaomi 13T', family: 'Xiaomi T', releaseRank: 2023 },
  { brandKey: 'xiaomi', name: 'Xiaomi 13 Pro', family: 'Xiaomi numbered', releaseRank: 2022 },
  { brandKey: 'xiaomi', name: 'Xiaomi 13', family: 'Xiaomi numbered', releaseRank: 2022 },
  { brandKey: 'xiaomi', name: 'Xiaomi 12T Pro', family: 'Xiaomi T', releaseRank: 2022 },
  { brandKey: 'xiaomi', name: 'Xiaomi 12T', family: 'Xiaomi T', releaseRank: 2022 },
  { brandKey: 'xiaomi', name: 'Xiaomi 12', family: 'Xiaomi numbered', releaseRank: 2021 },
  { brandKey: 'xiaomi', name: 'Xiaomi 11T Pro', family: 'Xiaomi T', releaseRank: 2021 },
  { brandKey: 'xiaomi', name: 'Xiaomi 11T', family: 'Xiaomi T', releaseRank: 2021 },
  { brandKey: 'xiaomi', name: 'Mi 11', family: 'Mi', releaseRank: 2021 },
  { brandKey: 'xiaomi', name: 'Mi 10', family: 'Mi', releaseRank: 2020 },
];

const redmi: CatalogueModel[] = [
  { brandKey: 'redmi', name: 'Redmi Note 14 Pro+', family: 'Redmi Note', releaseRank: 2025, aliases: ['note 14 pro plus'] },
  { brandKey: 'redmi', name: 'Redmi Note 14 Pro', family: 'Redmi Note', releaseRank: 2025 },
  { brandKey: 'redmi', name: 'Redmi Note 14', family: 'Redmi Note', releaseRank: 2025 },
  { brandKey: 'redmi', name: 'Redmi Note 13 Pro+', family: 'Redmi Note', releaseRank: 2024, aliases: ['note 13 pro plus'] },
  { brandKey: 'redmi', name: 'Redmi Note 13 Pro', family: 'Redmi Note', releaseRank: 2024 },
  { brandKey: 'redmi', name: 'Redmi Note 13', family: 'Redmi Note', releaseRank: 2024 },
  { brandKey: 'redmi', name: 'Redmi Note 12 Pro+', family: 'Redmi Note', releaseRank: 2023 },
  { brandKey: 'redmi', name: 'Redmi Note 12 Pro', family: 'Redmi Note', releaseRank: 2023 },
  { brandKey: 'redmi', name: 'Redmi Note 12', family: 'Redmi Note', releaseRank: 2023 },
  { brandKey: 'redmi', name: 'Redmi Note 11 Pro', family: 'Redmi Note', releaseRank: 2022 },
  { brandKey: 'redmi', name: 'Redmi Note 11', family: 'Redmi Note', releaseRank: 2022 },
  { brandKey: 'redmi', name: 'Redmi Note 10 Pro', family: 'Redmi Note', releaseRank: 2021 },
  { brandKey: 'redmi', name: 'Redmi Note 10', family: 'Redmi Note', releaseRank: 2021 },
  { brandKey: 'redmi', name: 'Redmi Note 9', family: 'Redmi Note', releaseRank: 2020 },
  { brandKey: 'redmi', name: 'Redmi 14C', family: 'Redmi numbered', releaseRank: 2024 },
  { brandKey: 'redmi', name: 'Redmi 13C', family: 'Redmi numbered', releaseRank: 2023 },
  { brandKey: 'redmi', name: 'Redmi 13', family: 'Redmi numbered', releaseRank: 2024 },
  { brandKey: 'redmi', name: 'Redmi 12C', family: 'Redmi numbered', releaseRank: 2023 },
  { brandKey: 'redmi', name: 'Redmi 12', family: 'Redmi numbered', releaseRank: 2023 },
  { brandKey: 'redmi', name: 'Redmi 10C', family: 'Redmi numbered', releaseRank: 2022 },
  { brandKey: 'redmi', name: 'Redmi 10', family: 'Redmi numbered', releaseRank: 2021 },
  { brandKey: 'redmi', name: 'Redmi 9A', family: 'Redmi numbered', releaseRank: 2020 },
  { brandKey: 'redmi', name: 'Redmi 9C', family: 'Redmi numbered', releaseRank: 2020 },
  { brandKey: 'redmi', name: 'Redmi A3', family: 'Redmi A', releaseRank: 2024 },
  { brandKey: 'redmi', name: 'Redmi A2', family: 'Redmi A', releaseRank: 2023 },
  { brandKey: 'redmi', name: 'Redmi A1', family: 'Redmi A', releaseRank: 2022 },
];

const poco: CatalogueModel[] = [
  { brandKey: 'poco', name: 'POCO F7 Pro', family: 'POCO F', releaseRank: 2025 },
  { brandKey: 'poco', name: 'POCO F6 Pro', family: 'POCO F', releaseRank: 2024 },
  { brandKey: 'poco', name: 'POCO F6', family: 'POCO F', releaseRank: 2024 },
  { brandKey: 'poco', name: 'POCO F5 Pro', family: 'POCO F', releaseRank: 2023 },
  { brandKey: 'poco', name: 'POCO F5', family: 'POCO F', releaseRank: 2023 },
  { brandKey: 'poco', name: 'POCO F4', family: 'POCO F', releaseRank: 2022 },
  { brandKey: 'poco', name: 'POCO X7 Pro', family: 'POCO X', releaseRank: 2025 },
  { brandKey: 'poco', name: 'POCO X6 Pro', family: 'POCO X', releaseRank: 2024 },
  { brandKey: 'poco', name: 'POCO X6', family: 'POCO X', releaseRank: 2024 },
  { brandKey: 'poco', name: 'POCO X5 Pro', family: 'POCO X', releaseRank: 2023 },
  { brandKey: 'poco', name: 'POCO X5', family: 'POCO X', releaseRank: 2023 },
  { brandKey: 'poco', name: 'POCO X4 Pro', family: 'POCO X', releaseRank: 2022 },
  { brandKey: 'poco', name: 'POCO M6 Pro', family: 'POCO M', releaseRank: 2024 },
  { brandKey: 'poco', name: 'POCO M6', family: 'POCO M', releaseRank: 2023 },
  { brandKey: 'poco', name: 'POCO M5', family: 'POCO M', releaseRank: 2022 },
  { brandKey: 'poco', name: 'POCO M4 Pro', family: 'POCO M', releaseRank: 2021 },
  { brandKey: 'poco', name: 'POCO C75', family: 'POCO C', releaseRank: 2024 },
  { brandKey: 'poco', name: 'POCO C65', family: 'POCO C', releaseRank: 2023 },
  { brandKey: 'poco', name: 'POCO C55', family: 'POCO C', releaseRank: 2023 },
];

const tecno: CatalogueModel[] = [
  { brandKey: 'tecno', name: 'Phantom V Fold2', family: 'Phantom', releaseRank: 2024 },
  { brandKey: 'tecno', name: 'Phantom V Flip2', family: 'Phantom', releaseRank: 2024 },
  { brandKey: 'tecno', name: 'Phantom V Fold', family: 'Phantom', releaseRank: 2023 },
  { brandKey: 'tecno', name: 'Phantom X2 Pro', family: 'Phantom', releaseRank: 2022 },
  { brandKey: 'tecno', name: 'Phantom X2', family: 'Phantom', releaseRank: 2022 },
  { brandKey: 'tecno', name: 'Camon 40 Pro', family: 'Camon', releaseRank: 2025 },
  { brandKey: 'tecno', name: 'Camon 40', family: 'Camon', releaseRank: 2025 },
  { brandKey: 'tecno', name: 'Camon 30 Pro', family: 'Camon', releaseRank: 2024 },
  { brandKey: 'tecno', name: 'Camon 30', family: 'Camon', releaseRank: 2024 },
  { brandKey: 'tecno', name: 'Camon 20 Pro', family: 'Camon', releaseRank: 2023 },
  { brandKey: 'tecno', name: 'Camon 20', family: 'Camon', releaseRank: 2023 },
  { brandKey: 'tecno', name: 'Camon 19 Pro', family: 'Camon', releaseRank: 2022 },
  { brandKey: 'tecno', name: 'Pova 6 Pro', family: 'Pova', releaseRank: 2024 },
  { brandKey: 'tecno', name: 'Pova 6', family: 'Pova', releaseRank: 2024 },
  { brandKey: 'tecno', name: 'Pova 5 Pro', family: 'Pova', releaseRank: 2023 },
  { brandKey: 'tecno', name: 'Pova 5', family: 'Pova', releaseRank: 2023 },
  { brandKey: 'tecno', name: 'Pova 4', family: 'Pova', releaseRank: 2022 },
  { brandKey: 'tecno', name: 'Spark 30 Pro', family: 'Spark', releaseRank: 2024 },
  { brandKey: 'tecno', name: 'Spark 30', family: 'Spark', releaseRank: 2024 },
  { brandKey: 'tecno', name: 'Spark 20 Pro', family: 'Spark', releaseRank: 2024 },
  { brandKey: 'tecno', name: 'Spark 20', family: 'Spark', releaseRank: 2023 },
  { brandKey: 'tecno', name: 'Spark 10 Pro', family: 'Spark', releaseRank: 2023 },
  { brandKey: 'tecno', name: 'Spark 10', family: 'Spark', releaseRank: 2023 },
  { brandKey: 'tecno', name: 'Spark 9', family: 'Spark', releaseRank: 2022 },
  { brandKey: 'tecno', name: 'Spark Go 2024', family: 'Spark', releaseRank: 2024 },
  { brandKey: 'tecno', name: 'Pop 8', family: 'Pop', releaseRank: 2024 },
  { brandKey: 'tecno', name: 'Pop 7', family: 'Pop', releaseRank: 2023 },
  { brandKey: 'tecno', name: 'Pop 6', family: 'Pop', releaseRank: 2022 },
];

const infinix: CatalogueModel[] = [
  { brandKey: 'infinix', name: 'Zero 40', family: 'Zero', releaseRank: 2024 },
  { brandKey: 'infinix', name: 'Zero 30', family: 'Zero', releaseRank: 2023 },
  { brandKey: 'infinix', name: 'Zero 20', family: 'Zero', releaseRank: 2022 },
  { brandKey: 'infinix', name: 'GT 20 Pro', family: 'GT', releaseRank: 2024 },
  { brandKey: 'infinix', name: 'GT 10 Pro', family: 'GT', releaseRank: 2023 },
  { brandKey: 'infinix', name: 'Note 40 Pro+', family: 'Note', releaseRank: 2024, aliases: ['note 40 pro plus'] },
  { brandKey: 'infinix', name: 'Note 40 Pro', family: 'Note', releaseRank: 2024 },
  { brandKey: 'infinix', name: 'Note 40', family: 'Note', releaseRank: 2024 },
  { brandKey: 'infinix', name: 'Note 30 Pro', family: 'Note', releaseRank: 2023 },
  { brandKey: 'infinix', name: 'Note 30', family: 'Note', releaseRank: 2023 },
  { brandKey: 'infinix', name: 'Note 12', family: 'Note', releaseRank: 2022 },
  { brandKey: 'infinix', name: 'Hot 50 Pro', family: 'Hot', releaseRank: 2024 },
  { brandKey: 'infinix', name: 'Hot 50', family: 'Hot', releaseRank: 2024 },
  { brandKey: 'infinix', name: 'Hot 40 Pro', family: 'Hot', releaseRank: 2023 },
  { brandKey: 'infinix', name: 'Hot 40', family: 'Hot', releaseRank: 2023 },
  { brandKey: 'infinix', name: 'Hot 30', family: 'Hot', releaseRank: 2023 },
  { brandKey: 'infinix', name: 'Hot 20', family: 'Hot', releaseRank: 2022 },
  { brandKey: 'infinix', name: 'Hot 12', family: 'Hot', releaseRank: 2022 },
  { brandKey: 'infinix', name: 'Smart 9', family: 'Smart', releaseRank: 2024 },
  { brandKey: 'infinix', name: 'Smart 8', family: 'Smart', releaseRank: 2023 },
  { brandKey: 'infinix', name: 'Smart 7', family: 'Smart', releaseRank: 2023 },
  { brandKey: 'infinix', name: 'Smart 6', family: 'Smart', releaseRank: 2022 },
];

const itel: CatalogueModel[] = [
  { brandKey: 'itel', name: 'City 100', family: 'City', releaseRank: 2024 },
  { brandKey: 'itel', name: 'Super 30', family: 'Super', releaseRank: 2024 },
  { brandKey: 'itel', name: 'Super 27', family: 'Super', releaseRank: 2024 },
  { brandKey: 'itel', name: 'Super 25', family: 'Super', releaseRank: 2023 },
  { brandKey: 'itel', name: 'S25 Ultra', family: 'itel S', releaseRank: 2024 },
  { brandKey: 'itel', name: 'S25', family: 'itel S', releaseRank: 2024 },
  { brandKey: 'itel', name: 'S24', family: 'itel S', releaseRank: 2023 },
  { brandKey: 'itel', name: 'S23+', family: 'itel S', releaseRank: 2023, aliases: ['s23 plus'] },
  { brandKey: 'itel', name: 'S23', family: 'itel S', releaseRank: 2023 },
  { brandKey: 'itel', name: 'A80', family: 'itel A', releaseRank: 2024 },
  { brandKey: 'itel', name: 'A70', family: 'itel A', releaseRank: 2024 },
  { brandKey: 'itel', name: 'A60s', family: 'itel A', releaseRank: 2023 },
  { brandKey: 'itel', name: 'A60', family: 'itel A', releaseRank: 2023 },
  { brandKey: 'itel', name: 'A50', family: 'itel A', releaseRank: 2022 },
  { brandKey: 'itel', name: 'Power 70', family: 'Power', releaseRank: 2024 },
  { brandKey: 'itel', name: 'P55', family: 'Power', releaseRank: 2023 },
  { brandKey: 'itel', name: 'P40', family: 'Power', releaseRank: 2023 },
  { brandKey: 'itel', name: 'RS4', family: 'RS', releaseRank: 2023 },
];

const oppo: CatalogueModel[] = [
  { brandKey: 'oppo', name: 'Find X8 Pro', family: 'Find X', releaseRank: 2024 },
  { brandKey: 'oppo', name: 'Find X8', family: 'Find X', releaseRank: 2024 },
  { brandKey: 'oppo', name: 'Find X7 Ultra', family: 'Find X', releaseRank: 2024 },
  { brandKey: 'oppo', name: 'Find X6 Pro', family: 'Find X', releaseRank: 2023 },
  { brandKey: 'oppo', name: 'Find X5 Pro', family: 'Find X', releaseRank: 2022 },
  { brandKey: 'oppo', name: 'Find N5', family: 'Find N', releaseRank: 2025 },
  { brandKey: 'oppo', name: 'Find N3', family: 'Find N', releaseRank: 2023 },
  { brandKey: 'oppo', name: 'Find N3 Flip', family: 'Find N', releaseRank: 2023 },
  { brandKey: 'oppo', name: 'Reno13 Pro', family: 'Reno', releaseRank: 2024 },
  { brandKey: 'oppo', name: 'Reno13', family: 'Reno', releaseRank: 2024 },
  { brandKey: 'oppo', name: 'Reno12 Pro', family: 'Reno', releaseRank: 2024 },
  { brandKey: 'oppo', name: 'Reno12', family: 'Reno', releaseRank: 2024 },
  { brandKey: 'oppo', name: 'Reno11 Pro', family: 'Reno', releaseRank: 2023 },
  { brandKey: 'oppo', name: 'Reno11', family: 'Reno', releaseRank: 2023 },
  { brandKey: 'oppo', name: 'Reno10 Pro', family: 'Reno', releaseRank: 2023 },
  { brandKey: 'oppo', name: 'Reno10', family: 'Reno', releaseRank: 2023 },
  { brandKey: 'oppo', name: 'Reno8', family: 'Reno', releaseRank: 2022 },
  { brandKey: 'oppo', name: 'Reno7', family: 'Reno', releaseRank: 2021 },
  { brandKey: 'oppo', name: 'A80', family: 'OPPO A', releaseRank: 2024 },
  { brandKey: 'oppo', name: 'A60', family: 'OPPO A', releaseRank: 2024 },
  { brandKey: 'oppo', name: 'A58', family: 'OPPO A', releaseRank: 2023 },
  { brandKey: 'oppo', name: 'A38', family: 'OPPO A', releaseRank: 2023 },
  { brandKey: 'oppo', name: 'A18', family: 'OPPO A', releaseRank: 2023 },
  { brandKey: 'oppo', name: 'A78', family: 'OPPO A', releaseRank: 2023 },
  { brandKey: 'oppo', name: 'A57', family: 'OPPO A', releaseRank: 2022 },
  { brandKey: 'oppo', name: 'A17', family: 'OPPO A', releaseRank: 2022 },
  { brandKey: 'oppo', name: 'A16', family: 'OPPO A', releaseRank: 2021 },
];

const realmeModels: CatalogueModel[] = [
  { brandKey: 'realme', name: 'GT 7 Pro', family: 'realme GT', releaseRank: 2024 },
  { brandKey: 'realme', name: 'GT 6', family: 'realme GT', releaseRank: 2024 },
  { brandKey: 'realme', name: 'GT 5 Pro', family: 'realme GT', releaseRank: 2023 },
  { brandKey: 'realme', name: 'GT Neo 5', family: 'realme GT', releaseRank: 2023 },
  { brandKey: 'realme', name: 'realme 13 Pro+', family: 'realme numbered', releaseRank: 2024, aliases: ['13 pro plus'] },
  { brandKey: 'realme', name: 'realme 13 Pro', family: 'realme numbered', releaseRank: 2024 },
  { brandKey: 'realme', name: 'realme 12 Pro+', family: 'realme numbered', releaseRank: 2024 },
  { brandKey: 'realme', name: 'realme 12 Pro', family: 'realme numbered', releaseRank: 2024 },
  { brandKey: 'realme', name: 'realme 12', family: 'realme numbered', releaseRank: 2024 },
  { brandKey: 'realme', name: 'realme 11 Pro+', family: 'realme numbered', releaseRank: 2023 },
  { brandKey: 'realme', name: 'realme 11 Pro', family: 'realme numbered', releaseRank: 2023 },
  { brandKey: 'realme', name: 'realme 11', family: 'realme numbered', releaseRank: 2023 },
  { brandKey: 'realme', name: 'realme 10', family: 'realme numbered', releaseRank: 2022 },
  { brandKey: 'realme', name: 'realme 9', family: 'realme numbered', releaseRank: 2022 },
  { brandKey: 'realme', name: 'C75', family: 'realme C', releaseRank: 2024 },
  { brandKey: 'realme', name: 'C65', family: 'realme C', releaseRank: 2024 },
  { brandKey: 'realme', name: 'C55', family: 'realme C', releaseRank: 2023 },
  { brandKey: 'realme', name: 'C53', family: 'realme C', releaseRank: 2023 },
  { brandKey: 'realme', name: 'C35', family: 'realme C', releaseRank: 2022 },
  { brandKey: 'realme', name: 'C33', family: 'realme C', releaseRank: 2022 },
  { brandKey: 'realme', name: 'C30', family: 'realme C', releaseRank: 2022 },
  { brandKey: 'realme', name: 'Note 60', family: 'realme Note', releaseRank: 2024 },
  { brandKey: 'realme', name: 'Note 50', family: 'realme Note', releaseRank: 2024 },
  { brandKey: 'realme', name: 'P1 Pro', family: 'realme P', releaseRank: 2024 },
  { brandKey: 'realme', name: 'P1', family: 'realme P', releaseRank: 2024 },
  { brandKey: 'realme', name: 'Narzo 70 Pro', family: 'Narzo', releaseRank: 2024 },
  { brandKey: 'realme', name: 'Narzo 60', family: 'Narzo', releaseRank: 2023 },
  { brandKey: 'realme', name: 'Narzo 50', family: 'Narzo', releaseRank: 2022 },
];

const huawei: CatalogueModel[] = [
  { brandKey: 'huawei', name: 'Pura 70 Ultra', family: 'Pura', releaseRank: 2024 },
  { brandKey: 'huawei', name: 'Pura 70 Pro', family: 'Pura', releaseRank: 2024 },
  { brandKey: 'huawei', name: 'Pura 70', family: 'Pura', releaseRank: 2024 },
  { brandKey: 'huawei', name: 'P60 Pro', family: 'Huawei P', releaseRank: 2023 },
  { brandKey: 'huawei', name: 'P50 Pro', family: 'Huawei P', releaseRank: 2021 },
  { brandKey: 'huawei', name: 'P40 Pro', family: 'Huawei P', releaseRank: 2020 },
  { brandKey: 'huawei', name: 'P30 Pro', family: 'Huawei P', releaseRank: 2019 },
  { brandKey: 'huawei', name: 'Mate 60 Pro', family: 'Mate', releaseRank: 2023 },
  { brandKey: 'huawei', name: 'Mate 50 Pro', family: 'Mate', releaseRank: 2022 },
  { brandKey: 'huawei', name: 'Mate X5', family: 'Mate', releaseRank: 2023 },
  { brandKey: 'huawei', name: 'Mate 40 Pro', family: 'Mate', releaseRank: 2020 },
  { brandKey: 'huawei', name: 'nova 13', family: 'nova', releaseRank: 2024 },
  { brandKey: 'huawei', name: 'nova 12', family: 'nova', releaseRank: 2023 },
  { brandKey: 'huawei', name: 'nova 11', family: 'nova', releaseRank: 2023 },
  { brandKey: 'huawei', name: 'nova 10', family: 'nova', releaseRank: 2022 },
  { brandKey: 'huawei', name: 'nova 9', family: 'nova', releaseRank: 2021 },
  { brandKey: 'huawei', name: 'Y9a', family: 'Huawei Y', releaseRank: 2020 },
  { brandKey: 'huawei', name: 'Y7a', family: 'Huawei Y', releaseRank: 2020 },
  { brandKey: 'huawei', name: 'Y6p', family: 'Huawei Y', releaseRank: 2020 },
];

const honor: CatalogueModel[] = [
  { brandKey: 'honor', name: 'Magic7 Pro', family: 'Magic', releaseRank: 2024 },
  { brandKey: 'honor', name: 'Magic7', family: 'Magic', releaseRank: 2024 },
  { brandKey: 'honor', name: 'Magic6 Pro', family: 'Magic', releaseRank: 2024 },
  { brandKey: 'honor', name: 'Magic5 Pro', family: 'Magic', releaseRank: 2023 },
  { brandKey: 'honor', name: 'Magic V3', family: 'Magic V', releaseRank: 2024 },
  { brandKey: 'honor', name: 'Magic V2', family: 'Magic V', releaseRank: 2023 },
  { brandKey: 'honor', name: 'Honor 200 Pro', family: 'Honor numbered', releaseRank: 2024 },
  { brandKey: 'honor', name: 'Honor 200', family: 'Honor numbered', releaseRank: 2024 },
  { brandKey: 'honor', name: 'Honor 90', family: 'Honor numbered', releaseRank: 2023 },
  { brandKey: 'honor', name: 'Honor 70', family: 'Honor numbered', releaseRank: 2022 },
  { brandKey: 'honor', name: 'X9c', family: 'Honor X', releaseRank: 2024 },
  { brandKey: 'honor', name: 'X9b', family: 'Honor X', releaseRank: 2023 },
  { brandKey: 'honor', name: 'X8b', family: 'Honor X', releaseRank: 2024 },
  { brandKey: 'honor', name: 'X7b', family: 'Honor X', releaseRank: 2024 },
  { brandKey: 'honor', name: 'X6b', family: 'Honor X', releaseRank: 2024 },
  { brandKey: 'honor', name: 'X8a', family: 'Honor X', releaseRank: 2023 },
  { brandKey: 'honor', name: 'X7a', family: 'Honor X', releaseRank: 2023 },
];

/**
 * Position within the brand, turned into a rank.
 *
 * Descending from a high base so the first model listed sorts first, and
 * spaced by ten so a model can be slipped between two others without
 * renumbering the brand.
 */
const RANK_BASE = 100_000;
const RANK_STEP = 10;

function ranked(models: CatalogueModel[]): RankedCatalogueModel[] {
  return models.map((m, index) => ({ ...m, displayRank: RANK_BASE - index * RANK_STEP }));
}

export const MODELS: readonly RankedCatalogueModel[] = [
  ...ranked(apple),
  ...ranked(samsung),
  ...ranked(xiaomi),
  ...ranked(redmi),
  ...ranked(poco),
  ...ranked(tecno),
  ...ranked(infinix),
  ...ranked(itel),
  ...ranked(oppo),
  ...ranked(realmeModels),
  ...ranked(huawei),
  ...ranked(honor),
];

/**
 * Search normalisation.
 *
 * Lower-cased, accents folded, punctuation dropped. So `Reno13` matches
 * "reno 13", `POCO X6` matches "poco-x6", and somebody typing `iphone 13 pro`
 * finds it without knowing how we spell it.
 */
export function normaliseSearch(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      /*
       * Split where letters meet digits, so `Reno13` and `reno 13` are the same
       * search. Manufacturers are wildly inconsistent about that space —
       * `Reno13` and `Galaxy S25` and `Note 14` are all current — and nobody
       * typing into a search box should have to remember which.
       */
      .replace(/([a-z])(\d)/g, '$1 $2')
      .replace(/(\d)([a-z])/g, '$1 $2')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  );
}

/** Every term a model answers to: its name, its family and its aliases. */
export function searchTermsFor(model: CatalogueModel): string {
  return normaliseSearch([model.name, model.family, ...(model.aliases ?? [])].join(' '));
}

/**
 * The canonical order: highest `displayRank` first.
 *
 * There is no tie-break, because there are no ties — every model has a distinct
 * rank derived from its position. That matters more than it looks: a comparator
 * that falls back to a name is a comparator that sorts differently in a
 * different language, and the catalogue must read the same in all three.
 */
export function byDisplayRank(a: RankedCatalogueModel, b: RankedCatalogueModel): number {
  return b.displayRank - a.displayRank;
}

export function modelsForBrand(brandKey: string): RankedCatalogueModel[] {
  return MODELS.filter((m) => m.brandKey === brandKey).sort(byDisplayRank);
}
