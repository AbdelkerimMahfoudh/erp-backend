/**
 * Reports company product rows that are probably the same phone written twice.
 *
 * READ-ONLY, on purpose and permanently. It prints; it never merges, renames,
 * repoints a unit or deletes anything.
 *
 * The reason is not caution for its own sake. Two rows that look identical to a
 * string comparison can be a real distinction somebody made deliberately — a
 * different market, a different bundle, an import batch kept apart for a
 * supplier dispute — and merging them moves units between products, which moves
 * cost, margin and history with them. That is a decision for a person who knows
 * the shop, informed by this list.
 *
 * Two kinds of duplicate are reported, and they are not the same problem:
 *
 *   COLLAPSIBLE — brand and model differ only by case, spacing or punctuation
 *                 ("iPhone 17 Pro Max" vs "iphone 17 pro max"). Almost always
 *                 a typo from the free-text era, before the brand/model
 *                 selector existed.
 *   VARIANT     — same canonical brand and model, different `variant`. Usually
 *                 CORRECT: variant carries storage and colour and is part of
 *                 the (company, brand, model, variant) unique key, so a 256 GB
 *                 black and a 512 GB blue are legitimately two rows. Listed so
 *                 the count can be reconciled, not because it is a fault.
 *
 * Model-level stock counting already folds both kinds into one line, so this
 * audit is about tidiness and reporting, not about a wrong number on screen.
 *
 * Usage:
 *   npx ts-node scripts/audit-duplicate-products.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Case, spacing and punctuation removed — what a person means by "the same". */
function canonical(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // accents, before the class below eats them
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function main() {
  const products = await prisma.product.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      companyId: true,
      brand: true,
      model: true,
      variant: true,
      trackingType: true,
      _count: { select: { units: true } },
    },
  });

  const groups = new Map<string, typeof products>();
  for (const p of products) {
    const key = `${p.companyId.toString('hex')}|${canonical(p.brand)}|${canonical(p.model)}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }

  let collapsible = 0;
  let variantOnly = 0;

  for (const [, rows] of groups) {
    if (rows.length < 2) continue;

    // Written differently, or only kept apart by storage and colour?
    const spellings = new Set(rows.map((r) => `${r.brand}|${r.model}`));
    const kind = spellings.size > 1 ? 'COLLAPSIBLE' : 'VARIANT';
    if (kind === 'COLLAPSIBLE') collapsible += 1;
    else variantOnly += 1;

    const units = rows.reduce((n, r) => n + r._count.units, 0);
    console.log(`\n${kind}  ${rows[0].brand} ${rows[0].model}  — ${rows.length} rows, ${units} units`);
    for (const r of rows) {
      console.log(
        `    ${r.id.toString('hex')}  ${JSON.stringify(r.brand)} ${JSON.stringify(r.model)}` +
          `  variant=${JSON.stringify(r.variant)}  units=${r._count.units}`,
      );
    }
  }

  console.log(
    `\n${products.length} products · ${collapsible} collapsible group(s) · ` +
      `${variantOnly} variant-only group(s)`,
  );
  console.log('Nothing was changed. Merging is a human decision.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
