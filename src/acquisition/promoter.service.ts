import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../common/config/app-config.service';
import { binToUuid, isUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { normalisePhone } from '../auth/identifier';
import { maskPhone } from '../auth/otp/otp-code.util';
import { PlatformAuditService } from '../platform/platform-audit.service';
import type { PlatformAdminIdentity } from '../platform/platform-admin.service';
import { AcquisitionService } from './acquisition.service';
import { newPromoCode } from './promo-code';
import { referralLink, signReferralToken } from './referral-token';

/**
 * The platform administrator's promoters (0103, D221): create one, give them a code and a QR link, turn them off and
 * on, and see which businesses registered through them. Attribution only — a promoter here has a name, a contact, a
 * code and a count of the businesses that registered through them.
 *
 * Privacy: the WhatsApp number and the note are this console's alone. A list shows the number masked; the audit trail
 * records that they changed, never what they are; nothing public ever reads them. Nothing here sends a message.
 */

export interface PromoterActor {
  admin: PlatformAdminIdentity;
  ip?: string | null;
}

export interface PromoterInput {
  displayName?: string;
  whatsappNumber?: string;
  note?: string | null;
}

/** How many fresh draws a code issue tries before giving up — a collision needs ~1,000 codes in use to be likely at all. */
const CODE_ATTEMPTS = 8;

const PROMOTER_VIEW = {
  id: true,
  publicRef: true,
  displayName: true,
  whatsappNumber: true,
  note: true,
  isActive: true,
  createdBy: true,
  updatedBy: true,
  createdAt: true,
  updatedAt: true,
  currentCode: { select: { id: true, code: true, version: true, issuedAt: true, issuedBy: true } },
} as const;

type PromoterRow = Prisma.PromoterGetPayload<{ select: typeof PROMOTER_VIEW }>;

@Injectable()
export class PromoterService {
  /** The draw — always the CSPRNG's; a seam only so a real-MySQL test can force a collision. */
  protected draw: () => string = newPromoCode;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly audit: PlatformAuditService,
    private readonly acquisition: AcquisitionService,
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  /** The list: name, masked number, code, state, creation, attributed registrations. Searched by name or code. */
  async list(query: { q?: string; page?: number }) {
    const take = 50;
    const page = Math.max(0, query.page ?? 0);
    const q = (query.q ?? '').trim().slice(0, 80);
    const where: Prisma.PromoterWhereInput = q
      ? /^[0-9]{6}$/.test(q)
        ? { currentCode: { is: { code: q } } }
        : { displayName: { contains: q } }
      : {};
    const [total, rows] = await Promise.all([
      this.prisma.promoter.count({ where }),
      this.prisma.promoter.findMany({ where, orderBy: { createdAt: 'desc' }, skip: page * take, take, select: PROMOTER_VIEW }),
    ]);
    const counts = await this.acquisition.promoterCounts(rows.map((r) => r.id));
    return {
      total,
      page,
      pageSize: take,
      rows: rows.map((r) => ({
        id: binToUuid(r.id),
        displayName: r.displayName,
        whatsappMasked: maskPhone(r.whatsappNumber),
        code: r.currentCode?.code ?? null,
        isActive: r.isActive,
        createdAt: r.createdAt.toISOString(),
        registrations: counts.get(binToUuid(r.id))?.registrations ?? 0,
        completedRegistrations: counts.get(binToUuid(r.id))?.completed ?? 0,
      })),
    };
  }

  /** One promoter, in full, for the administrator: the number and note included, the QR link, the code's history. */
  async detail(id: string) {
    const row = await this.find(id);
    const [history, counts] = await Promise.all([
      this.prisma.promoterCode.findMany({
        where: { promoterId: row.id },
        orderBy: { version: 'desc' },
        select: { code: true, version: true, issuedAt: true, issuedBy: true, retiredAt: true, retiredBy: true },
      }),
      this.acquisition.promoterCounts([row.id]),
    ]);
    return {
      ...this.view(row),
      whatsappNumber: row.whatsappNumber,
      note: row.note,
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt.toISOString(),
      registrations: counts.get(binToUuid(row.id))?.registrations ?? 0,
      completedRegistrations: counts.get(binToUuid(row.id))?.completed ?? 0,
      codeHistory: history.map((h) => ({
        code: h.code,
        version: h.version,
        issuedAt: h.issuedAt.toISOString(),
        issuedBy: h.issuedBy,
        retiredAt: h.retiredAt?.toISOString() ?? null,
        retiredBy: h.retiredBy,
      })),
    };
  }

  /** The businesses that registered through this promoter, newest first. */
  async businesses(id: string, page?: number) {
    const row = await this.find(id);
    return this.acquisition.report({ source: 'promoter', promoterId: row.id, page });
  }

  // ── Mutations (each audited, in its own transaction) ───────────────────────

  async create(input: PromoterInput, ctx: PromoterActor) {
    const displayName = this.nameOf(input.displayName);
    const whatsappNumber = this.numberOf(input.whatsappNumber);
    const note = this.noteOf(input.note);
    const id = newUuidV7Bin();
    const by = ctx.admin.email.slice(0, 160);
    await this.prisma.$transaction(async (tx) => {
      await tx.promoter.create({
        data: { id, publicRef: randomBytes(16), displayName, whatsappNumber, note, isActive: true, createdBy: by, updatedBy: by },
      });
      await this.audit.record(
        {
          admin: ctx.admin,
          action: 'promoter.create',
          targetType: 'promoter',
          targetId: id,
          targetLabel: displayName,
          after: { displayName, isActive: true, hasNote: note !== null },
          ip: ctx.ip ?? null,
        },
        tx,
      );
    });
    return this.detail(binToUuid(id));
  }

  async update(id: string, input: PromoterInput, ctx: PromoterActor) {
    const promoterId = this.idOf(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM promoters WHERE id = ${promoterId} FOR UPDATE`);
      const before = await tx.promoter.findUnique({ where: { id: promoterId }, select: { displayName: true, whatsappNumber: true, note: true } });
      if (!before) throw new NotFoundException('No such promoter.');
      const data: Prisma.PromoterUpdateInput = {};
      if (input.displayName !== undefined) data.displayName = this.nameOf(input.displayName);
      if (input.whatsappNumber !== undefined) data.whatsappNumber = this.numberOf(input.whatsappNumber);
      if (input.note !== undefined) data.note = this.noteOf(input.note);
      const changed = {
        displayName: data.displayName !== undefined && data.displayName !== before.displayName,
        whatsappNumber: data.whatsappNumber !== undefined && data.whatsappNumber !== before.whatsappNumber,
        note: data.note !== undefined && data.note !== before.note,
      };
      if (!changed.displayName && !changed.whatsappNumber && !changed.note) return;
      await tx.promoter.update({ where: { id: promoterId }, data: { ...data, updatedBy: ctx.admin.email.slice(0, 160), updatedAt: new Date() } });
      // What changed, never the number or the note themselves.
      await this.audit.record(
        {
          admin: ctx.admin,
          action: 'promoter.update',
          targetType: 'promoter',
          targetId: promoterId,
          targetLabel: (data.displayName as string | undefined) ?? before.displayName,
          before: changed.displayName ? { displayName: before.displayName } : undefined,
          after: {
            ...(changed.displayName ? { displayName: data.displayName } : {}),
            whatsappNumberChanged: changed.whatsappNumber,
            noteChanged: changed.note,
          },
          ip: ctx.ip ?? null,
        },
        tx,
      );
    });
    return this.detail(id);
  }

  /**
   * Generate the promoter's code and QR link — the console's explicit "Generate code and QR" — or, with `regenerate`,
   * replace them: the old code is retired (and never issued again), the new one takes the next version, and every QR
   * link signed with the old version stops opening. Nothing is ever deleted; the history stays.
   */
  async issueCode(id: string, opts: { regenerate: boolean }, ctx: PromoterActor) {
    const promoterId = this.idOf(id);
    // A code without its QR link would be half a card: refused before anything is written.
    this.acquisition.requireReferralKey();
    const by = ctx.admin.email.slice(0, 160);
    await this.prisma.$transaction(async (tx) => {
      // Two administrators generating at once are serialised here.
      await tx.$queryRaw(Prisma.sql`SELECT id FROM promoters WHERE id = ${promoterId} FOR UPDATE`);
      const promoter = await tx.promoter.findUnique({
        where: { id: promoterId },
        select: { displayName: true, currentCode: { select: { id: true, version: true } } },
      });
      if (!promoter) throw new NotFoundException('No such promoter.');
      const current = promoter.currentCode;
      if (current && !opts.regenerate) {
        throw new ConflictException({ code: 'promoter_code_exists', message: 'This promoter already has a code. Regenerate it to replace it.' });
      }
      if (!current && opts.regenerate) {
        throw new ConflictException({ code: 'promoter_code_missing', message: 'This promoter has no code yet. Generate one first.' });
      }
      const now = new Date();
      if (current) await tx.promoterCode.update({ where: { id: current.id }, data: { retiredAt: now, retiredBy: by } });
      const last = await tx.promoterCode.aggregate({ where: { promoterId }, _max: { version: true } });
      const version = (last._max.version ?? 0) + 1;
      const codeId = await this.insertCode(tx, promoterId, version, by, now);
      await tx.promoter.update({ where: { id: promoterId }, data: { currentCodeId: codeId, updatedBy: by, updatedAt: now } });
      await this.audit.record(
        {
          admin: ctx.admin,
          action: current ? 'promoter.code_regenerated' : 'promoter.code_issued',
          targetType: 'promoter',
          targetId: promoterId,
          targetLabel: promoter.displayName,
          // The version only: the digits are a credential the audit never keeps.
          before: current ? { codeVersion: current.version } : undefined,
          after: { codeVersion: version },
          ip: ctx.ip ?? null,
          at: now,
        },
        tx,
      );
    });
    return this.detail(id);
  }

  /** Turn a promoter off (their code and QR link stop opening, nothing is retired) or back on. */
  async setActive(id: string, active: boolean, ctx: PromoterActor) {
    const promoterId = this.idOf(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM promoters WHERE id = ${promoterId} FOR UPDATE`);
      const promoter = await tx.promoter.findUnique({ where: { id: promoterId }, select: { displayName: true, isActive: true } });
      if (!promoter) throw new NotFoundException('No such promoter.');
      if (promoter.isActive === active) return;
      await tx.promoter.update({ where: { id: promoterId }, data: { isActive: active, updatedBy: ctx.admin.email.slice(0, 160), updatedAt: new Date() } });
      await this.audit.record(
        {
          admin: ctx.admin,
          action: active ? 'promoter.activate' : 'promoter.deactivate',
          targetType: 'promoter',
          targetId: promoterId,
          targetLabel: promoter.displayName,
          before: { isActive: promoter.isActive },
          after: { isActive: active },
          ip: ctx.ip ?? null,
        },
        tx,
      );
    });
    return this.detail(id);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * A fresh CSPRNG code, unique for ever. A collision is the database's to detect (`ux_promoter_codes_code`); MySQL
   * rolls back only the failed statement, so the transaction draws again.
   */
  private async insertCode(tx: Prisma.TransactionClient, promoterId: Buffer, version: number, by: string, at: Date): Promise<Buffer> {
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
      const id = newUuidV7Bin();
      try {
        await tx.promoterCode.create({ data: { id, promoterId, code: this.draw(), version, issuedBy: by, issuedAt: at } });
        return id;
      } catch (e) {
        const collision =
          e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && String((e.meta as { target?: unknown })?.target ?? '').includes('code');
        if (!collision) throw e;
      }
    }
    throw new ConflictException({ code: 'promoter_code_unavailable', message: 'A new code could not be drawn. Try again.' });
  }

  private view(row: PromoterRow) {
    const key = this.config.referralKey;
    const code = row.currentCode;
    const token = key && code ? signReferralToken(key, { kind: 'promoter', ref: row.publicRef, version: code.version }) : null;
    return {
      id: binToUuid(row.id),
      displayName: row.displayName,
      whatsappMasked: maskPhone(row.whatsappNumber),
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
      code: code ? { code: code.code, version: code.version, issuedAt: code.issuedAt.toISOString(), issuedBy: code.issuedBy } : null,
      // The QR card's link, signed again on every read: nothing that could be replayed is stored.
      qrLink: token && this.config.portalOrigin ? referralLink(this.config.portalOrigin, token) : null,
    };
  }

  private async find(id: string): Promise<PromoterRow> {
    const row = await this.prisma.promoter.findUnique({ where: { id: this.idOf(id) }, select: PROMOTER_VIEW });
    if (!row) throw new NotFoundException('No such promoter.');
    return row;
  }

  private idOf(id: string): Buffer {
    if (!isUuid(id)) throw new NotFoundException('No such promoter.');
    return uuidToBin(id);
  }

  private nameOf(raw: string | undefined): string {
    const name = (raw ?? '').trim().replace(/\s+/g, ' ');
    if (!name || name.length > 80) throw new BadRequestException('Give the promoter a display name of up to 80 characters.');
    return name;
  }

  private numberOf(raw: string | undefined): string {
    const number = raw?.trim() ? normalisePhone(raw) : null;
    if (!number || number.length > 21) throw new BadRequestException('Give the promoter’s WhatsApp number, with its country code if it is not Mauritanian.');
    return number;
  }

  private noteOf(raw: string | null | undefined): string | null {
    const note = (raw ?? '').trim();
    if (note.length > 500) throw new BadRequestException('Keep the note to 500 characters.');
    return note || null;
  }
}
