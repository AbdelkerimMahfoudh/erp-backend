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
  iat?: number;
  exp?: number;
}
