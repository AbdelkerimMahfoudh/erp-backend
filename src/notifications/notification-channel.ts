/**
 * A delivery channel for notifications. The in-app channel (persist to
 * `notifications`) ships in Sprint 1; FCM push and WhatsApp are future providers
 * implementing the same interface.
 */
export interface NotificationInput {
  branchId?: Buffer | null;
  /** Target user; null = broadcast to the branch/company. */
  targetUserId?: Buffer | null;
  type: string;
  title: string;
  body?: string;
  actionLink?: string;
}

export interface NotificationChannel {
  deliver(input: NotificationInput): Promise<void>;
}

export const NOTIFICATION_CHANNELS = 'NOTIFICATION_CHANNELS';
