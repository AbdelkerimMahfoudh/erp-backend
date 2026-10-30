/**
 * A delivery channel for notifications. The in-app channel (persist to
 * `notifications`) ships in Sprint 1; FCM push and WhatsApp are future providers
 * implementing the same interface.
 */
export interface NotificationInput {
  /**
   * The business it is for, when that is not the caller's: the other side of a loan or a consignment (D225). Written
   * with the system client, because the tenant client writes every row into the caller's own business.
   */
  companyId?: Buffer;
  branchId?: Buffer | null;
  /** Target user; null = broadcast to the branch/company. */
  targetUserId?: Buffer | null;
  type: string;
  title: string;
  body?: string;
  /** A typed destination (`notification-target.ts`). */
  actionLink?: string;
  /** The structured fields the app words the event from, in the reader's language (D225). */
  payload?: Record<string, unknown>;
  /** Who did it: never pushed their own action (D225). */
  actorUserId?: Buffer | null;
}

export interface NotificationChannel {
  deliver(input: NotificationInput): Promise<void>;
}

export const NOTIFICATION_CHANNELS = 'NOTIFICATION_CHANNELS';
