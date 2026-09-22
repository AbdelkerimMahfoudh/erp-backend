import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import type { PlatformAdminIdentity } from './platform-admin.service';

/**
 * Every platform mutation, written down and never rewritten.
 *
 * The table is append-only in the database, not merely by convention — a
 * trigger refuses `UPDATE` and `DELETE` from the application account. "Who
 * suspended this shop, and why" is exactly the question somebody asks months
 * later, and an answer that can be quietly edited is worth nothing.
 */

/** Fields that must never reach the log, whatever shape they arrive in. */
const NEVER_LOG = [
  'password',
  'currentPassword',
  'confirmPassword',
  'passwordHash',
  'token',
  'sessionToken',
  'accessToken',
  'refreshToken',
  'refreshTokenHash',
  'code',
  'codeHash',
  'verificationCode',
  'secret',
  'deviceSecret',
];

/**
 * Strip anything secret before it is written.
 *
 * Belt and braces: callers are expected to pass only state worth keeping, but
 * an audit log is exactly the place where a careless spread of a request body
 * would go unnoticed for a long time — the record looks fine, and the password
 * is three levels down inside it.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (NEVER_LOG.some((banned) => k.toLowerCase() === banned.toLowerCase())) {
      out[k] = '[redacted]';
      continue;
    }
    out[k] = redact(v, depth + 1);
  }
  return out;
}

export interface AuditInput {
  admin: PlatformAdminIdentity | null;
  /**
   * Who acted, when it was not an administrator — an Owner accepting an
   * invitation, say. Absent, the administrator's address is used, and with no
   * administrator either the record says `system`.
   */
  actor?: string;
  action: string;
  targetType: string;
  targetId?: Buffer | null;
  targetLabel?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

@Injectable()
export class PlatformAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditInput): Promise<void> {
    await this.prisma.platformAuditEvent.create({
      data: {
        id: newUuidV7Bin(),
        adminId: input.admin?.id ?? null,
        // Kept as text as well, so the record still reads if the admin row goes.
        actor: (input.actor ?? input.admin?.email ?? 'system').slice(0, 160),
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        targetLabel: input.targetLabel?.slice(0, 200) ?? null,
        reason: input.reason?.slice(0, 500) ?? null,
        beforeJson: (redact(input.before) ?? undefined) as never,
        afterJson: (redact(input.after) ?? undefined) as never,
        ip: input.ip ?? null,
      },
    });
  }
}
