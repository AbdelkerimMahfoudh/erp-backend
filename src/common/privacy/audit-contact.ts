/**
 * What an audit row may say about a contact (privacy correction, 2026-10-12).
 *
 * The audit trail is hash-chained and append-only (0085): a value written into
 * it cannot be taken out again when the person it belongs to is deleted. So a
 * new audit row never holds a phone number, an email address or a payer's
 * number — only whether one was there. Rows written before this rule keep what
 * they hold; the deletion summary says so (docs/24).
 */
export function contactPresence(value: string | null | undefined): 'set' | null {
  return value ? 'set' : null;
}

/**
 * Who asked, for a record a Super Admin reads (a seat request, an activation):
 * the person's account id — never their email or number, which would outlive
 * their deletion in a column nobody de-identifies.
 */
export function actorRef(userId: string): string {
  return `user:${userId}`;
}
