import { StockTransfer, TransferStatus } from '@prisma/client';
import { binToUuid } from '../common/utils/uuid.util';
import { TERMINAL_STATUSES } from './transfer-state-machine';

/**
 * What the app is told about a transfer, and what it may do with it.
 *
 * The server decides availability, not the client. The app still has to know
 * WHY something is unavailable — a missing permission is a different sentence
 * from "you are standing in the wrong branch", and only one of them has a
 * button. So each action reports an allowed flag, a reason, and the branch it
 * must be performed from.
 */

/**
 * When a transfer was shipped — or null, because it never was.
 *
 * `stock_transfers.sent_at` carries `DEFAULT now()` from the original schema, so
 * every row has a value whether or not anything was ever sent. Blanking it by
 * status alone was not enough: a transfer cancelled AFTER approval is neither
 * `pending_approval` nor `approved`, so it kept the default and the app listed
 * "Sent by somebody" for goods that never left the shop.
 *
 * `sentById` is written only by shipping, so it is the honest signal. The
 * status check stays for rows shipped before that column was populated.
 */
export function shippedAt(transfer: {
  status: string;
  sentAt: Date | null;
  sentById: Buffer | null;
}): Date | null {
  const shipped =
    transfer.sentById !== null || transfer.status === 'in_transit' || transfer.status === 'received';
  return shipped ? transfer.sentAt : null;
}

export type ActionReason = 'status' | 'permission' | 'branch' | 'ownership' | null;

export interface TransferAction {
  allowed: boolean;
  /** Why not, when `allowed` is false. Null when allowed. */
  reason: ActionReason;
  /** The branch this action must be performed from — what "Switch to…" needs. */
  branchId: string;
  branchName: string;
}

export type TransferActions = Record<'approve' | 'reject' | 'ship' | 'receive' | 'cancel', TransferAction>;

interface Branchish {
  id: Buffer;
  name: string;
}

export interface ActionInputs {
  transfer: Pick<StockTransfer, 'status' | 'requestedById'>;
  from: Branchish;
  to: Branchish;
  activeBranchId: Buffer;
  userId: Buffer | null;
  permissions: ReadonlySet<string>;
}

/**
 * Decide one action, reporting the FIRST reason it is unavailable.
 *
 * Order matters and is deliberate: status first, because a received transfer
 * cannot be approved by anybody from anywhere and saying "wrong branch" would
 * send the user somewhere pointless. Then permission, then branch — so a user
 * who simply lacks the authority is never invited to switch branches to
 * discover that.
 */
function decide(
  ok: boolean,
  permitted: boolean,
  requiredBranch: Branchish,
  activeBranchId: Buffer,
  extra?: { ok: boolean; reason: ActionReason },
): TransferAction {
  const base = { branchId: binToUuid(requiredBranch.id), branchName: requiredBranch.name };
  if (!ok) return { allowed: false, reason: 'status', ...base };
  if (!permitted) return { allowed: false, reason: 'permission', ...base };
  if (extra && !extra.ok) return { allowed: false, reason: extra.reason, ...base };
  if (!requiredBranch.id.equals(activeBranchId)) return { allowed: false, reason: 'branch', ...base };
  return { allowed: true, reason: null, ...base };
}

export function computeActions(input: ActionInputs): TransferActions {
  const { transfer, from, to, activeBranchId, userId, permissions } = input;
  const has = (p: string) => permissions.has(p);
  const status = transfer.status;

  const pending = status === 'pending_approval';
  const preShipment = pending || status === 'approved';

  /**
   * Cancellation has two layers, exactly as the service enforces them.
   * `transfer.cancel_own` is the route key everyone who cancels holds;
   * `transfer.cancel` is the breadth key for somebody else's transfer. Without
   * breadth you may only withdraw your OWN request, and only while it is still
   * pending — once a manager has agreed, undoing that is a manager's decision.
   */
  const isRequester = Boolean(userId && transfer.requestedById?.equals(userId));
  const cancelBreadth = has('transfer.cancel')
    ? { ok: true, reason: null as ActionReason }
    : { ok: isRequester && pending, reason: 'ownership' as ActionReason };

  return {
    approve: decide(pending, has('transfer.approve'), from, activeBranchId),
    reject: decide(pending, has('transfer.approve'), from, activeBranchId),
    ship: decide(status === 'approved', has('transfer.ship'), from, activeBranchId),
    receive: decide(status === 'in_transit', has('transfer.receive'), to, activeBranchId),
    cancel: decide(preShipment, has('transfer.cancel_own'), from, activeBranchId, cancelBreadth),
  };
}

/** True once the transfer can never move again. Drives the history sections. */
export function isFinished(status: TransferStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * When a transfer was requested.
 *
 * There is no `created_at` column, and `sent_at` cannot stand in: it carries
 * `DEFAULT now()` from the original schema AND is rewritten on shipment, so a
 * pending transfer's `sent_at` is a creation time wearing a shipping label.
 * The primary key is a UUIDv7, whose first 48 bits are the millisecond the row
 * was made — an exact answer that needs no migration.
 */
export function requestedAtOf(id: Buffer): Date {
  return new Date(id.readUIntBE(0, 6));
}
