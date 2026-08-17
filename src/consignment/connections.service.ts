import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import {
  isVisibleInSearch,
  parseQuery,
  SEARCH_LIMITS,
  SearchRejected,
  toConnectedDetail,
  toPublicPreview,
  type PublicStorePreview,
} from './discovery';

/**
 * Finding and trusting another shop (H-CP2).
 *
 * **This service deliberately uses the UNSCOPED Prisma client.** Every other
 * service in the application uses `TENANT_PRISMA`, which injects `companyId`
 * into every query and fails closed. Discovery cannot: its entire purpose is to
 * look at companies that are not yours.
 *
 * That makes this the most dangerous file in the codebase, so it is also the
 * narrowest. It reads exactly four columns from `companies`, only for rows that
 * opted in, and it hands them to `toPublicPreview` — which takes the whole row
 * and returns only what may be published, so a column added to `companies`
 * tomorrow cannot widen what leaks today.
 */
@Injectable()
export class ConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
  ) {}

  /**
   * Search for a shop to do business with.
   *
   * Bounded three ways: an exact Store Account ID, an exact phone number, or a
   * name prefix of at least three characters — and never more than ten results.
   * A shop that is not discoverable, is inactive, or has blocked the searcher
   * is simply absent, indistinguishable from one that does not exist.
   */
  async search(rawQuery: string): Promise<{ rows: PublicStorePreview[] }> {
    const me = this.tenant.companyId();

    let parsed;
    try {
      parsed = parseQuery(rawQuery);
    } catch (e) {
      if (e instanceof SearchRejected) throw new BadRequestException(e.message);
      throw e;
    }

    const where: Prisma.CompanyWhereInput =
      parsed.mode === 'storeId'
        ? { publicStoreId: parsed.value }
        : parsed.mode === 'phone'
          ? { publicPhone: parsed.value }
          : // `startsWith`, never `contains`: a substring match on a
            // three-letter fragment would return most of the platform.
            { name: { startsWith: parsed.value } };

    const found = await this.prisma.company.findMany({
      where: { ...where, isDiscoverable: true, isActive: true },
      select: {
        id: true,
        publicStoreId: true,
        name: true,
        city: true,
        logoRef: true,
      },
      take: SEARCH_LIMITS.maxResults,
      orderBy: { name: 'asc' },
    });
    if (found.length === 0) return { rows: [] };

    // One query for every block involving me, rather than one per result.
    const blocked = await this.blockedCompanyIds(me);

    return {
      rows: found
        .filter((c) =>
          isVisibleInSearch({
            isDiscoverable: true,
            isActive: true,
            blockedEitherWay: blocked.has(binToUuid(c.id)),
            isSelf: c.id.equals(me),
          }),
        )
        .map(toPublicPreview),
    };
  }

  /** Every company in a blocked relationship with me, in either direction. */
  private async blockedCompanyIds(me: Buffer): Promise<Set<string>> {
    const rows = await this.prisma.storeConnection.findMany({
      where: {
        status: 'blocked',
        OR: [{ requesterCompanyId: me }, { addresseeCompanyId: me }],
      },
      select: { requesterCompanyId: true, addresseeCompanyId: true },
    });
    const out = new Set<string>();
    for (const r of rows) {
      out.add(binToUuid(r.requesterCompanyId));
      out.add(binToUuid(r.addresseeCompanyId));
    }
    out.delete(binToUuid(me));
    return out;
  }

  /** The connections I have, in whichever direction they were requested. */
  async list() {
    const me = this.tenant.companyId();
    const rows = await this.prisma.storeConnection.findMany({
      where: { OR: [{ requesterCompanyId: me }, { addresseeCompanyId: me }] },
      include: {
        requesterCompany: { select: { id: true, publicStoreId: true, name: true, city: true, logoRef: true, publicPhone: true } },
        addresseeCompany: { select: { id: true, publicStoreId: true, name: true, city: true, logoRef: true, publicPhone: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return {
      rows: rows.map((c) => {
        const iAmRequester = c.requesterCompanyId.equals(me);
        const them = iAmRequester ? c.addresseeCompany : c.requesterCompany;
        return {
          id: binToUuid(c.id),
          status: c.status,
          /**
           * Which way round it was asked, so the screen can say "they asked
           * you" rather than making somebody work it out from two company
           * names.
           */
          direction: iAmRequester ? ('outgoing' as const) : ('incoming' as const),
          /** Only I can act on a request somebody sent ME. */
          canDecide: !iAmRequester && c.status === 'pending',
          blockedByMe: c.blockedByCompanyId?.equals(me) ?? false,
          blockReason: c.blockReason,
          note: c.note,
          store: toConnectedDetail(them, c.status === 'accepted'),
          createdAt: c.createdAt,
          version: c.version,
        };
      }),
    };
  }

  /** Ask another shop to connect. */
  async request(publicStoreId: string, note?: string) {
    const me = this.tenant.companyId();
    const userId = this.tenant.userId() ?? null;

    const them = await this.prisma.company.findFirst({
      where: { publicStoreId: publicStoreId.trim().toUpperCase(), isDiscoverable: true, isActive: true },
      select: { id: true },
    });
    /**
     * The same 404 a nonexistent store gets. A shop that is not discoverable,
     * or has blocked me, must not be distinguishable from one that is not there
     * — otherwise this endpoint becomes the oracle that search refuses to be.
     */
    if (!them || them.id.equals(me)) throw new NotFoundException('No such store');

    const existing = await this.prisma.storeConnection.findFirst({
      where: {
        OR: [
          { requesterCompanyId: me, addresseeCompanyId: them.id },
          { requesterCompanyId: them.id, addresseeCompanyId: me },
        ],
      },
    });
    if (existing?.status === 'blocked') {
      // Deliberately the same answer as "no such store".
      throw new NotFoundException('No such store');
    }
    if (existing) {
      throw new ConflictException(
        existing.status === 'accepted'
          ? 'You are already connected to that store'
          : 'There is already a request between you and that store',
      );
    }

    const id = newUuidV7Bin();
    await this.prisma.storeConnection.create({
      data: {
        id,
        requesterCompanyId: me,
        addresseeCompanyId: them.id,
        status: 'pending',
        requestedById: userId,
        note: note?.trim() || null,
      },
    });

    await this.audit.record({
      entityType: 'StoreConnection',
      entityId: id,
      action: 'create',
      after: { to: publicStoreId, status: 'pending' },
    });
    return this.list();
  }

  /**
   * Accept or reject a request somebody sent me.
   *
   * Only the addressee may decide — a requester who could accept their own
   * request would have connected to every shop on the platform.
   */
  async decide(id: string, accept: boolean, expectedVersion?: number) {
    const me = this.tenant.companyId();
    const userId = this.tenant.userId() ?? null;

    const conn = await this.mine(id);
    if (!conn.addresseeCompanyId.equals(me)) {
      throw new NotFoundException('No such request');
    }
    if (conn.status !== 'pending') {
      throw new ConflictException('That request has already been decided');
    }
    if (expectedVersion != null && expectedVersion !== conn.version) {
      throw new ConflictException('refresh_required: this request changed while you were deciding it');
    }

    const won = await this.prisma.storeConnection.updateMany({
      where: { id: conn.id, version: conn.version, status: 'pending' },
      data: {
        status: accept ? 'accepted' : 'rejected',
        decidedById: userId,
        decidedAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (won.count === 0) {
      throw new ConflictException('refresh_required: this request changed while you were deciding it');
    }

    if (accept) await this.ensureCounterparty(me, conn.requesterCompanyId, conn.id);

    await this.audit.record({
      entityType: 'StoreConnection',
      entityId: conn.id,
      action: 'update',
      before: { status: 'pending' },
      after: { status: accept ? 'accepted' : 'rejected' },
    });
    return this.list();
  }

  /**
   * Block a shop, or lift a block I placed.
   *
   * Blocking stops NEW requests and consignments. It deliberately does not
   * delete history and does not erase an outstanding balance — a shop cannot
   * escape what it owes by blocking the creditor.
   */
  async setBlocked(id: string, blocked: boolean, reason?: string) {
    const me = this.tenant.companyId();
    const conn = await this.mine(id);

    if (blocked) {
      if (conn.status === 'blocked') throw new ConflictException('That store is already blocked');
      await this.prisma.storeConnection.update({
        where: { id: conn.id },
        data: {
          status: 'blocked',
          blockedByCompanyId: me,
          blockedAt: new Date(),
          blockReason: reason?.trim() || null,
          version: { increment: 1 },
        },
      });
    } else {
      if (conn.status !== 'blocked') throw new ConflictException('That store is not blocked');
      /**
       * Only the company that placed the block may lift it. Without this the
       * blocked party could simply unblock themselves, which would make
       * blocking decorative.
       */
      if (!conn.blockedByCompanyId?.equals(me)) {
        throw new ConflictException('Only the store that blocked can unblock');
      }
      await this.prisma.storeConnection.update({
        where: { id: conn.id },
        data: {
          // Back to pending, not accepted: unblocking restores the conversation,
          // not the trust.
          status: 'pending',
          blockedByCompanyId: null,
          blockedAt: null,
          blockReason: null,
          version: { increment: 1 },
        },
      });
    }

    await this.audit.record({
      entityType: 'StoreConnection',
      entityId: conn.id,
      action: 'status_change',
      after: { blocked, reason: reason?.trim() ?? null },
    });
    return this.list();
  }

  // --- counterparties -------------------------------------------------------

  /** Every counterparty this company deals with — connected and manual alike. */
  async listCounterparties() {
    const me = this.tenant.companyId();
    const rows = await this.prisma.counterparty.findMany({
      where: { companyId: me, isActive: true },
      orderBy: { name: 'asc' },
      take: 200,
    });
    return {
      rows: rows.map((c) => ({
        id: binToUuid(c.id),
        kind: c.kind,
        name: c.name,
        phone: c.phone,
        city: c.city,
        note: c.note,
        connectedStoreId: c.connectedCompanyId ? binToUuid(c.connectedCompanyId) : null,
      })),
    };
  }

  /**
   * Record a shop or person who does not use the application.
   *
   * Deliberately NOT a `Company` row. Inventing one would give a corner shop a
   * Store Account ID, a tenant scope and a login path, none of which it should
   * have — and it would then appear in everybody else's discovery.
   */
  async createManualCounterparty(input: {
    kind: 'manual_store' | 'manual_person';
    name: string;
    phone?: string;
    city?: string;
    note?: string;
  }) {
    const me = this.tenant.companyId();
    if (!input.name?.trim()) throw new BadRequestException('A counterparty needs a name');

    const id = newUuidV7Bin();
    await this.prisma.counterparty.create({
      data: {
        id,
        companyId: me,
        kind: input.kind,
        name: input.name.trim(),
        phone: input.phone?.trim() || null,
        city: input.city?.trim() || null,
        note: input.note?.trim() || null,
        createdById: this.tenant.userId() ?? null,
      },
    });
    await this.audit.record({
      entityType: 'Counterparty',
      entityId: id,
      action: 'create',
      after: { kind: input.kind, name: input.name.trim() },
    });
    return this.listCounterparties();
  }

  // --- helpers --------------------------------------------------------------

  /**
   * A connection I am part of, or a 404.
   *
   * Never a 403: telling somebody "that connection exists but is not yours"
   * would let them enumerate ids and learn which shops are connected to each
   * other.
   */
  private async mine(id: string) {
    const me = this.tenant.companyId();
    const conn = await this.prisma.storeConnection.findFirst({
      where: {
        id: uuidToBin(id),
        OR: [{ requesterCompanyId: me }, { addresseeCompanyId: me }],
      },
    });
    if (!conn) throw new NotFoundException('No such connection');
    return conn;
  }

  /**
   * Give each side a counterparty row on acceptance.
   *
   * Both sides get one, because either may later consign or lend to the other,
   * and a counterparty created lazily at that moment would race.
   */
  private async ensureCounterparty(me: Buffer, them: Buffer, connectionId: Buffer) {
    const pairs: [Buffer, Buffer][] = [
      [me, them],
      [them, me],
    ];
    for (const [owner, other] of pairs) {
      const existing = await this.prisma.counterparty.findFirst({
        where: { companyId: owner, connectedCompanyId: other },
      });
      if (existing) continue;
      const company = await this.prisma.company.findUnique({
        where: { id: other },
        select: { name: true, city: true, publicPhone: true },
      });
      await this.prisma.counterparty.create({
        data: {
          id: newUuidV7Bin(),
          companyId: owner,
          kind: 'connected_store',
          connectedCompanyId: other,
          connectionId,
          // Snapshotted, so a rename on their side cannot retitle our records.
          name: company?.name ?? 'Connected store',
          phone: company?.publicPhone ?? null,
          city: company?.city ?? null,
        },
      });
    }
  }
}
