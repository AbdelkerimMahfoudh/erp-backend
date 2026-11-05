import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { binToUuid } from '../common/utils/uuid.util';
import { PrismaService } from '../prisma/prisma.service';
import { NoticeService } from '../notices/notice.service';
import { SeatAllocationService } from './seat-allocation.service';

/** The longest name a branch may have (the column's own limit). */
export const BRANCH_NAME_MAX = 160;
export const BRANCH_LOCATION_MAX = 160;
/** An idempotency key the app sends: its own random id, 8 to 80 safe characters. */
const REQUEST_KEY = /^[A-Za-z0-9_-]{8,80}$/;

/**
 * Where a branch added in the app stands (0130), as the app shows it — never a price, a plan or a way to pay:
 * - `pending_activation`: waiting for the Owner to subscribe on the portal;
 * - `proof_under_review`: a payment proof was sent from the portal and waits for the platform's decision;
 * - `scheduled`: paid during the business's free trial, opening when the trial ends (D176) — it receives no trial;
 * - `active`: the branch exists and can be chosen (it is then in the branch list itself, not here);
 * - `cancelled` / `rejected`: withdrawn, or refused by the platform.
 */
export type BranchRequestState = 'pending_activation' | 'proof_under_review' | 'scheduled' | 'active' | 'cancelled' | 'rejected';

export interface BranchRequestView {
  id: string;
  name: string;
  location: string | null;
  state: BranchRequestState;
  requestedAt: string;
  /** Once active: the branch it became. */
  branchId: string | null;
}

/** A name as it is compared for duplicates: trimmed, spaces collapsed, case and accents folded. */
export function normalizeBranchName(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
}

/**
 * A branch the Owner adds in the app (0130; the owner's brief of 2026-11-05).
 *
 * It is a store request awaiting activation — never a branch yet: no `branches` row exists until the platform approves its
 * payment, so nothing operational can reach it (no sale, stock, money, staff or selection), it holds no seat and counts as
 * no operating store, and it never receives a free trial. The Owner only. Safe to repeat: the app's key returns the one
 * request made; the same name again — however it is spaced or cased — is refused. The Owner's WhatsApp notice is queued
 * after the request commits and can never undo it. The active branch is not changed.
 */
@Injectable()
export class BranchRequestsService {
  private readonly log = new Logger(BranchRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly allocations: SeatAllocationService,
    private readonly notices: NoticeService,
  ) {}

  /** The Owner of this business, by their role in it; anyone else is refused before anything is read. */
  async assertOwner(companyId: Buffer, userId: Buffer): Promise<void> {
    const owner = await this.prisma.userBranch.count({ where: { companyId, userId, role: { key: 'owner' } } });
    if (owner === 0) throw new ForbiddenException({ code: 'owner_only', message: 'Only the Owner can add a branch.' });
  }

  async create(
    companyId: Buffer,
    userId: Buffer,
    input: { name?: unknown; location?: unknown; requestKey?: unknown },
    actor: string,
  ): Promise<{ request: BranchRequestView; created: boolean }> {
    await this.assertOwner(companyId, userId);
    const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
    if (!name) throw new BadRequestException({ code: 'branch_name_required', message: 'Name the branch.' });
    if (name.length > BRANCH_NAME_MAX) throw new BadRequestException({ code: 'branch_name_too_long', message: `A branch name is at most ${BRANCH_NAME_MAX} characters.` });
    const location = typeof input.location === 'string' ? input.location.trim().replace(/\s+/g, ' ') : '';
    if (location.length > BRANCH_LOCATION_MAX) throw new BadRequestException({ code: 'branch_location_too_long', message: `A location is at most ${BRANCH_LOCATION_MAX} characters.` });
    const requestKey = typeof input.requestKey === 'string' ? input.requestKey : '';
    if (!REQUEST_KEY.test(requestKey)) throw new BadRequestException({ code: 'request_key_missing', message: 'Missing request key.' });

    // The same key again — a double tap, a retry, an answer lost on the way: the one request made.
    const same = await this.prisma.seatAllocation.findFirst({ where: { companyId, requestKey }, select: { id: true } });
    if (same) return { request: await this.viewOf(companyId, same.id), created: false };

    // The same name, however spaced or cased, as a branch the business has or one already waiting: refused.
    const wanted = normalizeBranchName(name);
    const [branches, waiting] = await Promise.all([
      this.prisma.branch.findMany({ where: { companyId, deletedAt: null }, select: { name: true } }),
      this.prisma.seatAllocation.findMany({ where: { companyId, kind: 'store', status: { in: ['pending_payment', 'scheduled'] } }, select: { label: true } }),
    ]);
    if ([...branches.map((b) => b.name), ...waiting.map((w) => w.label ?? '')].some((n) => normalizeBranchName(n) === wanted)) {
      throw new ConflictException({ code: 'branch_name_in_use', message: 'A branch with that name already exists.' });
    }

    let result: Awaited<ReturnType<SeatAllocationService['requestStore']>>;
    try {
      result = await this.allocations.requestStore(companyId, { name, location: location || null, requestKey, pendingOnly: true, requestedBy: actor });
    } catch (e) {
      // Two taps at once with the same key: the unique key decided, and the other one is the request.
      const raced = await this.prisma.seatAllocation.findFirst({ where: { companyId, requestKey }, select: { id: true } });
      if (raced) return { request: await this.viewOf(companyId, raced.id), created: false };
      throw e;
    }
    const id = Buffer.from(result.allocation.id.replace(/-/g, ''), 'hex');
    // After the commit, never inside it: the notice can fail, wait or be retried without touching the request.
    if (result.created) await this.notices.enqueueBranchActivation(companyId, id);
    return { request: await this.viewOf(companyId, id), created: result.created };
  }

  /** The business's branches waiting for activation (and recently decided), for the Owner's branch list; [] for anyone else. */
  async list(companyId: Buffer, userId: Buffer): Promise<BranchRequestView[]> {
    const owner = await this.prisma.userBranch.count({ where: { companyId, userId, role: { key: 'owner' } } });
    if (owner === 0) return [];
    const rows = await this.prisma.seatAllocation.findMany({
      where: { companyId, kind: 'store', status: { in: ['pending_payment', 'scheduled'] } },
      orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    return Promise.all(rows.map((r) => this.viewOf(companyId, r.id)));
  }

  /** One request, for its read-only status page; the Owner only. */
  async one(companyId: Buffer, userId: Buffer, id: Buffer): Promise<BranchRequestView> {
    await this.assertOwner(companyId, userId);
    return this.viewOf(companyId, id);
  }

  private async viewOf(companyId: Buffer, id: Buffer): Promise<BranchRequestView> {
    const row = await this.prisma.seatAllocation.findFirst({
      where: { id, companyId, kind: 'store' },
      select: { id: true, label: true, location: true, status: true, requestedAt: true, branchId: true },
    });
    if (!row) throw new BadRequestException({ code: 'branch_request_unknown', message: 'Unknown branch request.' });
    let state: BranchRequestState;
    switch (row.status) {
      case 'pending_payment': {
        const review = await this.prisma.paymentProof.count({ where: { companyId, status: { in: ['submitted', 'under_review'] } } });
        state = review > 0 ? 'proof_under_review' : 'pending_activation';
        break;
      }
      case 'scheduled':
        state = 'scheduled';
        break;
      case 'paid':
      case 'granted':
        state = 'active';
        break;
      case 'refused':
        state = 'rejected';
        break;
      default:
        state = 'cancelled';
    }
    return {
      id: binToUuid(row.id),
      name: row.label ?? '',
      location: row.location,
      state,
      requestedAt: row.requestedAt.toISOString(),
      branchId: row.branchId ? binToUuid(row.branchId) : null,
    };
  }
}
