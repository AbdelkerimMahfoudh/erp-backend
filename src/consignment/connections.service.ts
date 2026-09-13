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
import {
  mayCancel,
  mayRemove,
  newDealingRefusal,
  resolveConnectionRequest,
  type ConnectionStatusLike,
  type CounterpartyKindLike,
} from './dealing-authorization';
import { sideOf } from './consignment-scope';
import { outstanding as consignmentOutstanding, type LedgerKind as ConsignmentLedgerKind } from './consignment-money';
import {
  directionFor,
  remaining as loanRemaining,
  type Direction,
  type LedgerKind as LoanLedgerKind,
} from '../loans/loan-rules';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

interface SharedPhone {
  consignmentId: string;
  brand: string | null;
  model: string | null;
  variant: string | null;
  identifier: string;
  custody: 'held' | 'in_transit';
}

const CLOSED_CONSIGNMENT = new Set(['settled', 'returned_accepted', 'forgiven_settled', 'cancelled']);
const CLOSED_LOAN = new Set(['settled', 'forgiven_settled', 'cancelled']);

/**
 * Whose move a loan is waiting for, from this store's side.
 *
 * Offers: the store that did NOT make the offer answers. Money: the debtor pays,
 * and only the creditor confirms a reported payment.
 */
export function loanWaitingOn(
  status: string,
  direction: Direction,
  proposedByMe: boolean,
): 'us' | 'them' | 'both' | 'none' {
  switch (status) {
    case 'proposed':
    case 'counter_proposed':
      return proposedByMe ? 'them' : 'us';
    case 'disputed':
      return 'both';
    case 'accepted':
    case 'partially_paid':
      return direction === 'they_owe_us' ? 'them' : 'us';
    case 'payment_awaiting_confirmation':
      return direction === 'they_owe_us' ? 'us' : 'them';
    default:
      return 'none';
  }
}

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
          canCancel: mayCancel(c.status as ConnectionStatusLike, iAmRequester),
          canRemove: mayRemove(c.status as ConnectionStatusLike),
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

  /**
   * Look a store up by its exact code, to confirm who a request would go to.
   *
   * Exactly the public preview search already gives — name, city, logo — plus
   * this store's OWN relationship with it, which the caller already knows. The
   * same privacy rules as search: not discoverable, inactive or blocked either
   * way are all "no such store".
   */
  async lookup(rawCode: string) {
    const me = this.tenant.companyId();
    const code = (rawCode ?? '').trim().toUpperCase();
    if (code.length !== 10) {
      throw new BadRequestException({ code: 'store_code_invalid', message: 'A store code is 10 characters' });
    }
    await this.refuseOwnCode(me, code);

    const company = await this.prisma.company.findFirst({
      where: { publicStoreId: code, isDiscoverable: true, isActive: true },
      select: { id: true, publicStoreId: true, name: true, city: true, logoRef: true },
    });
    if (!company) throw new NotFoundException('No such store');

    const existing = await this.pairRow(me, company.id);
    if (existing?.status === 'blocked') throw new NotFoundException('No such store');

    return {
      store: toPublicPreview(company),
      relationship: existing
        ? {
            id: binToUuid(existing.id),
            status: existing.status,
            direction: existing.requesterCompanyId.equals(me) ? ('outgoing' as const) : ('incoming' as const),
          }
        : null,
    };
  }

  /**
   * Ask another shop to connect.
   *
   * Every way two shops can already be related is resolved by
   * `resolveConnectionRequest`, and every outcome is safe to repeat: a retry of
   * my own request writes nothing, and two requests crossing in flight both
   * resolve against the single row the unique pair key allows — one creates it,
   * the other finds it. Nothing here ever accepts on the other store's behalf.
   */
  async request(publicStoreId: string, note?: string) {
    const me = this.tenant.companyId();
    const userId = this.tenant.userId() ?? null;
    const code = publicStoreId.trim().toUpperCase();

    await this.refuseOwnCode(me, code);

    const them = await this.prisma.company.findFirst({
      where: { publicStoreId: code, isDiscoverable: true, isActive: true },
      select: { id: true },
    });
    /**
     * The same 404 a nonexistent store gets. A shop that is not discoverable,
     * or has blocked me, must not be distinguishable from one that is not there
     * — otherwise this endpoint becomes the oracle that search refuses to be.
     */
    if (!them || them.id.equals(me)) throw new NotFoundException('No such store');

    // Twice at most: once normally, once more if a concurrent write moved the row.
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await this.pairRow(me, them.id);
      const outcome = resolveConnectionRequest(
        existing
          ? { status: existing.status as ConnectionStatusLike, requesterIsMe: existing.requesterCompanyId.equals(me) }
          : null,
      );

      if (outcome.kind === 'refuse') {
        const body = { code: outcome.code, message: outcome.message };
        throw outcome.status === 404 ? new NotFoundException('No such store') : new ConflictException(body);
      }

      if (outcome.kind === 'already_requested') return this.list();

      if (outcome.kind === 'reopen' && existing) {
        const won = await this.prisma.storeConnection.updateMany({
          where: { id: existing.id, version: existing.version, status: existing.status },
          data: {
            // Re-oriented: the store asking NOW is the requester, and the other
            // store is the one that must accept again.
            requesterCompanyId: me,
            addresseeCompanyId: them.id,
            status: 'pending',
            requestedById: userId,
            decidedById: null,
            decidedAt: null,
            note: note?.trim() || null,
            version: { increment: 1 },
          },
        });
        if (won.count === 0) continue;
        await this.audit.record({
          entityType: 'StoreConnection',
          entityId: existing.id,
          action: 'status_change',
          before: { status: existing.status },
          after: { to: code, status: 'pending', reopened: true },
        });
        return this.list();
      }

      const id = newUuidV7Bin();
      try {
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
      } catch (e) {
        // The other store's request (or my own retry) created the pair first.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }
      await this.audit.record({
        entityType: 'StoreConnection',
        entityId: id,
        action: 'create',
        after: { to: code, status: 'pending' },
      });
      return this.list();
    }
    throw new ConflictException({
      code: 'refresh_required',
      message: 'That relationship changed while the request was being sent. Refresh and try again.',
    });
  }

  /** Withdraw a request I sent, before it is answered. */
  async cancel(id: string, expectedVersion?: number) {
    const me = this.tenant.companyId();
    const conn = await this.mine(id);
    if (!mayCancel(conn.status as ConnectionStatusLike, conn.requesterCompanyId.equals(me))) {
      throw new ConflictException({
        code: 'connection_not_cancellable',
        message: 'Only a request you sent, and that is still waiting, can be withdrawn',
      });
    }
    await this.transition(conn, 'cancelled', expectedVersion);
    return this.list();
  }

  /**
   * End an accepted connection, from either side.
   *
   * New dealings stop at once — `assertMayStartDealing` re-reads the status
   * inside every commit. Nothing already agreed, sent, owed or held is touched:
   * both stores can still return consigned phones, report and confirm payments,
   * resolve disputes and read their shared history.
   */
  async remove(id: string, expectedVersion?: number) {
    const conn = await this.mine(id);
    if (!mayRemove(conn.status as ConnectionStatusLike)) {
      throw new ConflictException({
        code: 'connection_not_removable',
        message: 'Only an accepted connection can be removed',
      });
    }
    await this.transition(conn, 'removed', expectedVersion);
    return this.list();
  }

  /**
   * One connected store, from this store's point of view.
   *
   * Only what both stores already share: consignments and loans between the
   * two companies, their ledgers, and the snapshotted identity of consigned
   * phones. Never the other store's inventory, purchase costs, margins,
   * customers or dealings with anybody else — none of it is queried.
   */
  async summary(id: string) {
    const me = this.tenant.companyId();
    const conn = await this.mine(id);
    const iAmRequester = conn.requesterCompanyId.equals(me);
    const themId = iAmRequester ? conn.addresseeCompanyId : conn.requesterCompanyId;

    const [company, consignments, loans] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: themId },
        select: { publicStoreId: true, name: true, city: true, logoRef: true, publicPhone: true },
      }),
      this.prisma.consignment.findMany({
        where: {
          OR: [
            { sourceCompanyId: me, destinationCompanyId: themId },
            { sourceCompanyId: themId, destinationCompanyId: me },
          ],
        },
        include: {
          lines: { select: { id: true, status: true, brand: true, model: true, variant: true, identifier: true } },
          ledger: { select: { kind: true, amount: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.loan.findMany({
        where: {
          OR: [
            { companyId: me, counterpartyCompanyId: themId },
            { companyId: themId, counterpartyCompanyId: me },
          ],
        },
        include: { ledger: { select: { kind: true, amount: true } } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);
    if (!company) throw new NotFoundException('No such connection');

    const meHex = binToUuid(me);
    let theyOweUs = 0;
    let weOweThem = 0;
    const ourItemsWithThem: SharedPhone[] = [];
    const theirItemsWithUs: SharedPhone[] = [];

    const consignmentRows = consignments.map((c) => {
      const side = sideOf(c, me);
      const owed = consignmentOutstanding(c.ledger.map((l) => ({ kind: l.kind as ConsignmentLedgerKind, amount: Number(l.amount) })));
      // The consignor is always the creditor: the holder owes for what it sold.
      if (owed > 0) side === 'source' ? (theyOweUs += owed) : (weOweThem += owed);

      const inTransit = c.status === 'custody_awaiting_confirmation' || c.status === 'return_in_transit';
      for (const line of c.lines) {
        const held = line.status === 'in_custody' || (inTransit && line.status === 'proposed');
        if (!held) continue;
        const phone: SharedPhone = {
          consignmentId: binToUuid(c.id),
          brand: line.brand,
          model: line.model,
          variant: line.variant,
          identifier: line.identifier,
          custody: inTransit ? 'in_transit' : 'held',
        };
        (side === 'source' ? ourItemsWithThem : theirItemsWithUs).push(phone);
      }

      return {
        type: 'consignment' as const,
        id: binToUuid(c.id),
        status: c.status,
        closed: CLOSED_CONSIGNMENT.has(c.status),
        side,
        phones: c.lines.length,
        agreedAmount: c.agreedAmount == null ? null : Number(c.agreedAmount),
        proposedAmount: c.proposedAmount == null ? null : Number(c.proposedAmount),
        outstanding: owed,
        createdAt: c.createdAt,
      };
    });

    const loanRows = loans.map((l) => {
      const direction = directionFor({ companyId: binToUuid(l.companyId), direction: l.direction as Direction }, meHex);
      const left = loanRemaining(l.ledger.map((e) => ({ kind: e.kind as LoanLedgerKind, amount: Number(e.amount) })));
      if (left > 0) direction === 'they_owe_us' ? (theyOweUs += left) : (weOweThem += left);
      return {
        type: 'loan' as const,
        id: binToUuid(l.id),
        status: l.status,
        closed: CLOSED_LOAN.has(l.status),
        direction,
        waitingOn: loanWaitingOn(l.status, direction, l.proposedByCompanyId.equals(me)),
        principal: l.principal == null ? null : Number(l.principal),
        proposedAmount: Number(l.proposedAmount),
        remaining: left,
        createdAt: l.createdAt,
      };
    });

    const status = conn.status as ConnectionStatusLike;
    return {
      id: binToUuid(conn.id),
      status,
      direction: iAmRequester ? ('outgoing' as const) : ('incoming' as const),
      version: conn.version,
      store: toConnectedDetail(company, status === 'accepted'),
      /** Whether a NEW dealing may start now. Existing ones are always settleable. */
      canStartDealing: status === 'accepted',
      canRemove: mayRemove(status),
      canCancel: mayCancel(status, iAmRequester),
      canDecide: !iAmRequester && status === 'pending',
      // Money and custody are separate facts and are never netted against each other.
      money: { theyOweUs: round2(theyOweUs), weOweThem: round2(weOweThem) },
      custody: { ourItemsWithThem, theirItemsWithUs },
      pending: [...consignmentRows, ...loanRows].filter((r) => !r.closed),
      history: [...consignmentRows, ...loanRows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    };
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
      include: { connection: { select: { id: true, status: true } } },
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
        connectionId: c.connection ? binToUuid(c.connection.id) : null,
        /**
         * Whether a NEW dealing may start with them. The same pure rule the
         * server enforces at commit, so a picker can say why a name is greyed
         * out — but it is only a hint; the commit re-checks.
         */
        canStartDealing:
          newDealingRefusal({
            kind: c.kind as CounterpartyKindLike,
            connectionStatus: (c.connection?.status as ConnectionStatusLike | undefined) ?? null,
          }) === null,
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
    /**
     * A shop recorded by hand could only ever be used to start dealings with no
     * accepted connection — which the Partners rule forbids. Refused here with
     * the reason, rather than created and then refused at every use. Existing
     * manual stores keep their records and can still be settled.
     */
    if (input.kind === 'manual_store') {
      throw new BadRequestException({
        code: 'connection_required',
        message: 'Stores are added through Partners, by connecting to them. A person can still be recorded by hand.',
      });
    }

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

  /** A store's own code is known to it, so saying so leaks nothing. */
  private async refuseOwnCode(me: Buffer, code: string) {
    const own = await this.prisma.company.findUnique({ where: { id: me }, select: { publicStoreId: true } });
    if (own?.publicStoreId?.toUpperCase() === code) {
      throw new BadRequestException({ code: 'connection_self', message: 'That is your own store code' });
    }
  }

  /** The single relationship row a pair of stores may have, whichever way round. */
  private pairRow(me: Buffer, them: Buffer) {
    return this.prisma.storeConnection.findFirst({
      where: {
        OR: [
          { requesterCompanyId: me, addresseeCompanyId: them },
          { requesterCompanyId: them, addresseeCompanyId: me },
        ],
      },
    });
  }

  /** Compare-and-swap a status change, recorded by whoever made it. */
  private async transition(
    conn: { id: Buffer; status: string; version: number },
    to: 'cancelled' | 'removed',
    expectedVersion?: number,
  ) {
    if (expectedVersion != null && expectedVersion !== conn.version) {
      throw new ConflictException({ code: 'refresh_required', message: 'This connection changed. Refresh and try again.' });
    }
    const won = await this.prisma.storeConnection.updateMany({
      where: { id: conn.id, version: conn.version, status: conn.status as never },
      data: {
        status: to,
        decidedById: this.tenant.userId() ?? null,
        decidedAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (won.count === 0) {
      throw new ConflictException({ code: 'refresh_required', message: 'This connection changed. Refresh and try again.' });
    }
    await this.audit.record({
      entityType: 'StoreConnection',
      entityId: conn.id,
      action: 'status_change',
      before: { status: conn.status },
      after: { status: to },
    });
  }

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
