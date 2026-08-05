/** The authenticated principal attached to a request (ids as strings). */
export interface AuthUser {
  userId: string;
  companyId: string;
}

/** JWT access-token payload. */
export interface AccessTokenPayload {
  sub: string;
  companyId: string;
  type: 'access';
  /**
   * The `auth_sessions` id this access token is bound to. Every request revalidates
   * the session (not revoked, not expired) and the user (active, not deleted), so
   * revoking the session — which deactivation does atomically — cuts off the access
   * token immediately and keeps it dead after any later reactivation.
   */
  sid: string;
  iat?: number;
  exp?: number;
}
