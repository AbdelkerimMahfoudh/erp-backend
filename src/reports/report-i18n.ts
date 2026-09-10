/**
 * Column headers and status words, in the three languages the app speaks.
 *
 * These live on the server rather than being sent from the phone, for one
 * reason: the file is generated on the server, and a header the client supplies
 * is a header a client can lie about. A spreadsheet whose columns are labelled
 * by the caller is a spreadsheet whose `revenue` column can be relabelled
 * `cost`.
 *
 * The locale arrives as a validated query parameter and falls back to English.
 * Arabic headers are written as ordinary text; the BOM the writer emits is what
 * makes a spreadsheet read them as UTF-8 instead of mojibake.
 */

export const REPORT_LOCALES = ['en', 'fr', 'ar'] as const;
export type ReportLocale = (typeof REPORT_LOCALES)[number];

export function isReportLocale(value: string): value is ReportLocale {
  return (REPORT_LOCALES as readonly string[]).includes(value);
}

type Dictionary = Record<string, string>;

const EN: Dictionary = {
  'report.profit-by-product': 'Profit by product',
  'report.profit-by-employee': 'Profit by employee',
  'report.profit-by-branch': 'Profit by branch',
  'report.movers': 'Movers',
  'report.dead-stock': 'Dead stock',
  'report.debtors-creditors': 'Debtors and creditors',

  'column.product': 'Product',
  'column.trackingType': 'Tracking',
  'column.qtySold': 'Quantity sold',
  'column.revenue': 'Revenue',
  'column.cogs': 'Cost of goods sold',
  'column.grossProfit': 'Gross profit',
  'column.netProfit': 'Net profit',
  'column.margin': 'Margin',
  'column.employee': 'Employee',
  'column.salesCount': 'Sales',
  'column.branch': 'Branch',
  'column.sold30d': 'Sold in 30 days',
  'column.lastSoldAt': 'Last sold',
  'column.inStock': 'In stock',
  'column.inventoryValue': 'Stock value',
  'column.direction': 'Direction',
  'column.source': 'Source',
  'column.counterparty': 'Counterparty',
  'column.status': 'Status',
  'column.since': 'Since',
  'column.outstanding': 'Outstanding',

  'value.owed_to_us': 'Owed to us',
  'value.owed_by_us': 'Owed by us',
  'value.loan': 'Loan',
  'value.supplier': 'Supplier',
  'value.imei': 'IMEI',
  'value.serial': 'Serial number',
  'value.quantity': 'Quantity',

  'meta.report': 'Report',
  'meta.generated': 'Generated',
  'meta.period': 'Period',
  'meta.asOf': 'As of',
  'meta.branch': 'Branch',
  'meta.allBranches': 'All branches',
  'meta.companyWide': 'All branches (this report always compares the whole company)',
  'meta.rows': 'Rows',
  'meta.ranking': 'Ranking',
};

const FR: Dictionary = {
  'report.profit-by-product': 'Bénéfice par produit',
  'report.profit-by-employee': 'Bénéfice par employé',
  'report.profit-by-branch': 'Bénéfice par succursale',
  'report.movers': 'Produits qui bougent',
  'report.dead-stock': 'Stock dormant',
  'report.debtors-creditors': 'Débiteurs et créanciers',

  'column.product': 'Produit',
  'column.trackingType': 'Suivi',
  'column.qtySold': 'Quantité vendue',
  'column.revenue': 'Chiffre d’affaires',
  'column.cogs': 'Coût des marchandises vendues',
  'column.grossProfit': 'Bénéfice brut',
  'column.netProfit': 'Bénéfice net',
  'column.margin': 'Marge',
  'column.employee': 'Employé',
  'column.salesCount': 'Ventes',
  'column.branch': 'Succursale',
  'column.sold30d': 'Vendus en 30 jours',
  'column.lastSoldAt': 'Dernière vente',
  'column.inStock': 'En stock',
  'column.inventoryValue': 'Valeur du stock',
  'column.direction': 'Sens',
  'column.source': 'Origine',
  'column.counterparty': 'Contrepartie',
  'column.status': 'Statut',
  'column.since': 'Depuis',
  'column.outstanding': 'Solde dû',

  'value.owed_to_us': 'Nous est dû',
  'value.owed_by_us': 'Nous devons',
  'value.loan': 'Prêt',
  'value.supplier': 'Fournisseur',
  'value.imei': 'IMEI',
  'value.serial': 'Numéro de série',
  'value.quantity': 'Quantité',

  'meta.report': 'Rapport',
  'meta.generated': 'Généré le',
  'meta.period': 'Période',
  'meta.asOf': 'Au',
  'meta.branch': 'Succursale',
  'meta.allBranches': 'Toutes les succursales',
  'meta.companyWide': 'Toutes les succursales (ce rapport compare toujours l’entreprise entière)',
  'meta.rows': 'Lignes',
  'meta.ranking': 'Classement',
};

const AR: Dictionary = {
  'report.profit-by-product': 'الربح حسب المنتج',
  'report.profit-by-employee': 'الربح حسب الموظف',
  'report.profit-by-branch': 'الربح حسب الفرع',
  'report.movers': 'المنتجات الأكثر حركة',
  'report.dead-stock': 'المخزون الراكد',
  'report.debtors-creditors': 'المدينون والدائنون',

  'column.product': 'المنتج',
  'column.trackingType': 'التتبع',
  'column.qtySold': 'الكمية المباعة',
  'column.revenue': 'الإيرادات',
  'column.cogs': 'تكلفة البضاعة المباعة',
  'column.grossProfit': 'الربح الإجمالي',
  'column.netProfit': 'الربح الصافي',
  'column.margin': 'الهامش',
  'column.employee': 'الموظف',
  'column.salesCount': 'المبيعات',
  'column.branch': 'الفرع',
  'column.sold30d': 'المباع خلال ٣٠ يوماً',
  'column.lastSoldAt': 'آخر بيع',
  'column.inStock': 'في المخزون',
  'column.inventoryValue': 'قيمة المخزون',
  'column.direction': 'الاتجاه',
  'column.source': 'المصدر',
  'column.counterparty': 'الطرف الآخر',
  'column.status': 'الحالة',
  'column.since': 'منذ',
  'column.outstanding': 'الرصيد المستحق',

  'value.owed_to_us': 'مستحق لنا',
  'value.owed_by_us': 'مستحق علينا',
  'value.loan': 'قرض',
  'value.supplier': 'مورد',
  'value.imei': 'IMEI',
  'value.serial': 'الرقم التسلسلي',
  'value.quantity': 'الكمية',

  'meta.report': 'التقرير',
  'meta.generated': 'تاريخ الإنشاء',
  'meta.period': 'الفترة',
  'meta.asOf': 'بتاريخ',
  'meta.branch': 'الفرع',
  'meta.allBranches': 'جميع الفروع',
  'meta.companyWide': 'جميع الفروع (هذا التقرير يقارن الشركة بأكملها دائماً)',
  'meta.rows': 'عدد الصفوف',
  'meta.ranking': 'الترتيب',
};

const DICTIONARIES: Record<ReportLocale, Dictionary> = { en: EN, fr: FR, ar: AR };

/** Every dictionary carries every key. Asserted by a test, not by hope. */
export function translationDrift(): string[] {
  const expected = Object.keys(EN).sort();
  const problems: string[] = [];
  for (const locale of REPORT_LOCALES) {
    const actual = Object.keys(DICTIONARIES[locale]).sort();
    for (const key of expected) {
      if (!DICTIONARIES[locale][key]) problems.push(`${locale} missing ${key}`);
    }
    for (const key of actual) {
      if (!EN[key]) problems.push(`${locale} has extra ${key}`);
    }
  }
  return problems;
}

/**
 * Look up a phrase. An unknown key returns the key itself rather than an empty
 * cell — a header reading `column.whatever` is a visible bug, and a blank one
 * is a file somebody quietly mis-reads.
 */
export function t(locale: ReportLocale, key: string): string {
  return DICTIONARIES[locale][key] ?? EN[key] ?? key;
}

/** A money column names the currency once, where it cannot break arithmetic. */
export function moneyHeader(locale: ReportLocale, key: string): string {
  return `${t(locale, key)} (MRU)`;
}
