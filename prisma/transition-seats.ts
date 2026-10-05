/**
 * The 2026-10-05 seat transition (docs/21): carry existing staff into the
 * per-store rule without deactivating or charging anybody.
 *
 * For every company, store by store: the first active non-Owner person holds
 * the store's included seat; every further one gets a GRANTED seat row (0 MRU,
 * `status = granted`, reason "transition"). Seats a company bought under the
 * pooled rule (`subscriptions.additional_seats`) are converted into PAID seat
 * rows at the stores that need them most (over-count first), then the oldest
 * store, and the pooled counter is set to zero so no seat is counted twice.
 *
 * Dry-run by default: prints what it would do and changes nothing. Pass
 * `--apply` to write. Idempotent: a store whose granted seats already cover
 * its people gets nothing more, and a converted pool is not converted again.
 *
 *   npx ts-node prisma/transition-seats.ts            # report only
 *   npx ts-node prisma/transition-seats.ts --apply    # write, with a log line per row
 *
 * Reads and writes with the application's own database identity; run it where
 * `APP_DATABASE_URL` points at the database the API uses, AFTER migration 0086
 * and BEFORE the API that enforces the rule is started.
 */
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient({ datasourceUrl: process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL });

/** UUIDv7 as 16 bytes — the same shape the API writes. */
function newId(): Buffer {
  const b = randomBytes(16);
  const ms = BigInt(Date.now());
  b.writeUIntBE(Number(ms >> 16n), 0, 4);
  b.writeUInt16BE(Number(ms & 0xffffn), 4);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  return b;
}

const hex = (b: Buffer) => b.toString('hex');

async function main() {
  const companies = await prisma.company.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  });

  let grantedTotal = 0;
  let convertedTotal = 0;
  const lines: string[] = [];

  for (const company of companies) {
    const sub = await prisma.subscription.findFirst({ where: { companyId: company.id } });
    if (!sub) {
      lines.push(`${company.name}: no subscription row — skipped`);
      continue;
    }
    const branches = await prisma.branch.findMany({
      where: { companyId: company.id, isActive: true, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
    const staff = await prisma.$queryRaw<{ branch_hex: string; n: bigint }[]>`
      SELECT HEX(ub.branch_id) AS branch_hex, COUNT(DISTINCT u.id) AS n
      FROM users u
      JOIN user_branches ub ON ub.user_id = u.id
      JOIN roles r ON r.id = ub.role_id
      WHERE u.company_id = ${company.id} AND u.is_active = 1 AND u.deleted_at IS NULL AND r.\`key\` <> 'owner'
      GROUP BY ub.branch_id
    `;
    const staffBy = new Map(staff.map((r) => [r.branch_hex.toLowerCase(), Number(r.n)]));
    const held = await prisma.seatAllocation.findMany({
      where: { companyId: company.id, kind: 'seat', status: { in: ['paid', 'granted'] } },
      select: { branchId: true },
    });
    const heldBy = new Map<string, number>();
    for (const h of held) if (h.branchId) heldBy.set(hex(h.branchId), (heldBy.get(hex(h.branchId)) ?? 0) + 1);

    let pool = sub.additionalSeats;
    // Stores with the most people beyond their seats first, so a bought pool lands where it is needed.
    const ranked = branches
      .map((b) => {
        const used = staffBy.get(hex(b.id)) ?? 0;
        const have = 1 + (heldBy.get(hex(b.id)) ?? 0);
        return { ...b, used, have, over: Math.max(0, used - have) };
      })
      .sort((a, b) => b.over - a.over);

    for (const b of ranked) {
      let over = b.over;
      let converted = 0;
      let granted = 0;
      while (over > 0 && pool > 0) {
        converted += 1;
        pool -= 1;
        over -= 1;
      }
      granted = over;
      if (converted === 0 && granted === 0) {
        lines.push(`${company.name} / ${b.name}: ${b.used} staff, ${b.have} seat(s) — nothing to do`);
        continue;
      }
      lines.push(
        `${company.name} / ${b.name}: ${b.used} staff, ${b.have} seat(s) → ${converted} converted from the pooled purchase (paid, 100 MRU), ${granted} granted (0 MRU, transition)`,
      );
      if (!APPLY) continue;
      await prisma.$transaction(async (tx) => {
        for (let i = 0; i < converted; i++) {
          await tx.seatAllocation.create({
            data: {
              id: newId(),
              companyId: company.id,
              subscriptionId: sub.id,
              branchId: b.id,
              kind: 'seat',
              status: 'paid',
              monthlyAmount: 100,
              requestedBy: 'transition 2026-10-05',
              confirmedBy: 'transition 2026-10-05',
              confirmedAt: new Date(),
              reason: 'Converted from a seat bought under the pooled rule (subscriptions.additional_seats).',
            },
          });
        }
        for (let i = 0; i < granted; i++) {
          await tx.seatAllocation.create({
            data: {
              id: newId(),
              companyId: company.id,
              subscriptionId: sub.id,
              branchId: b.id,
              kind: 'seat',
              status: 'granted',
              monthlyAmount: 0,
              requestedBy: 'transition 2026-10-05',
              confirmedBy: 'transition 2026-10-05',
              confirmedAt: new Date(),
              reason:
                'Staff above the included seat when the per-store rule took effect (docs/21, 2026-10-05). Not charged; nobody deactivated.',
            },
          });
        }
      });
      grantedTotal += granted;
      convertedTotal += converted;
    }

    // Any pooled seats left over are kept as paid seats at the oldest store, so nothing bought is lost.
    if (pool > 0 && branches.length > 0) {
      const first = branches[0];
      lines.push(`${company.name} / ${first.name}: ${pool} unused pooled seat(s) kept as paid seats here`);
      if (APPLY) {
        for (let i = 0; i < pool; i++) {
          await prisma.seatAllocation.create({
            data: {
              id: newId(),
              companyId: company.id,
              subscriptionId: sub.id,
              branchId: first.id,
              kind: 'seat',
              status: 'paid',
              monthlyAmount: 100,
              requestedBy: 'transition 2026-10-05',
              confirmedBy: 'transition 2026-10-05',
              confirmedAt: new Date(),
              reason: 'Unused seat bought under the pooled rule, kept at the first store.',
            },
          });
        }
        convertedTotal += pool;
      }
    }
    if (APPLY && sub.additionalSeats > 0) {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { additionalSeats: 0, version: { increment: 1 } },
      });
      await prisma.subscriptionEvent.create({
        data: {
          id: newId(),
          companyId: company.id,
          subscriptionId: sub.id,
          kind: 'seats_changed',
          note: `Transition 2026-10-05: ${sub.additionalSeats} pooled seat(s) converted to per-store seats.`,
          seatsAfter: 0,
          actor: 'transition 2026-10-05',
        },
      });
    }
  }

  for (const l of lines) console.log(l);
  console.log(
    `\n${APPLY ? 'Applied' : 'Would apply'}: ${grantedTotal} granted seat(s), ${convertedTotal} converted seat(s) across ${companies.length} company(ies).`,
  );
  if (!APPLY) console.log('Dry run. Re-run with --apply to write.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
