import { OtpService } from './otp.service';
import { VerificationIntentService } from './verification-intent.service';
import { TestWhatsAppChannel } from '../../messaging/channels';
import { DisabledWhatsAppChannel } from '../../messaging/channels';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../../common/utils/uuid.util';

/**
 * OTP lifecycle (F1 Stage 4A).
 *
 * The in-memory Prisma double below enforces the two constraints the design
 * actually leans on — the UNIQUE `active_key` and the conditional
 * status transitions — because a double that always succeeds would let a
 * broken race guard pass here and fail in a shop.
 */

const COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c001');
const OTHER_COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c002');
const USER = uuidToBin('018f0000-0000-7000-8000-00000000a001');
const OTHER_USER = uuidToBin('018f0000-0000-7000-8000-00000000a002');
const PHONE = '+22231234567';
const PEPPER = 'test-pepper-at-least-32-characters-long!!';

interface Row {
  id: Buffer;
  companyId: Buffer;
  userId: Buffer;
  purpose: string;
  deviceId: Buffer | null;
  destination: string;
  candidatePhone: string | null;
  codeHash: string;
  status: string;
  activeKey: string | null;
  createdAt: Date;
  expiresAt: Date;
  attemptCount: number;
  maxAttempts: number;
  lastAttemptAt: Date | null;
  sendCount: number;
  lastSentAt: Date | null;
  resendNotBefore: Date | null;
  verifiedAt: Date | null;
  consumedAt: Date | null;
  cancelledAt: Date | null;
  lockedAt: Date | null;
  provider: string | null;
  providerMessageId: string | null;
  deliveryState: string;
  deliveryDetail: string | null;
  idempotencyKey: string | null;
}

function makeHarness(opts: { pepper?: string | null; channel?: TestWhatsAppChannel | DisabledWhatsAppChannel } = {}) {
  const rows: Row[] = [];
  const audits: Record<string, unknown>[] = [];
  const channel = opts.channel ?? new TestWhatsAppChannel();

  const matches = (r: Row, where: Record<string, any>): boolean => {
    for (const [k, v] of Object.entries(where)) {
      if (k === 'OR') {
        if (!(v as Record<string, any>[]).some((c) => matches(r, c))) return false;
        continue;
      }
      const actual = (r as never as Record<string, unknown>)[k];
      if (v && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Date)) {
        const cond = v as Record<string, unknown>;
        if ('gte' in cond && !(actual instanceof Date && actual >= (cond.gte as Date))) return false;
        if ('lte' in cond && !(actual instanceof Date && actual <= (cond.lte as Date))) return false;
        if ('lt' in cond && !(actual instanceof Date && actual < (cond.lt as Date))) return false;
        continue;
      }
      if (Buffer.isBuffer(v)) {
        if (!Buffer.isBuffer(actual) || !actual.equals(v)) return false;
        continue;
      }
      if (actual !== v) return false;
    }
    return true;
  };

  const apply = (r: Row, data: Record<string, any>) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && 'increment' in v) {
        (r as never as Record<string, number>)[k] += (v as { increment: number }).increment;
      } else {
        (r as never as Record<string, unknown>)[k] = v;
      }
    }
  };

  const db: any = {
    otpChallenge: {
      create: jest.fn(async ({ data }: any) => {
        // The UNIQUE index on active_key, enforced for real.
        if (data.activeKey && rows.some((r) => r.activeKey === data.activeKey)) {
          const e: any = new Error('Unique constraint failed');
          e.code = 'P2002';
          throw e;
        }
        const row: Row = {
          status: 'pending',
          attemptCount: 0,
          sendCount: 0,
          lastAttemptAt: null,
          lastSentAt: null,
          resendNotBefore: null,
          verifiedAt: null,
          consumedAt: null,
          cancelledAt: null,
          lockedAt: null,
          provider: null,
          providerMessageId: null,
          deliveryState: 'not_sent',
          deliveryDetail: null,
          createdAt: new Date(),
          candidatePhone: null,
          deviceId: null,
          idempotencyKey: null,
          ...data,
        };
        rows.push(row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.id.equals(where.id)) ?? null),
      findFirst: jest.fn(async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id.equals(where.id))!;
        apply(row, data);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hits = rows.filter((r) => matches(r, where));
        for (const h of hits) apply(h, data);
        return { count: hits.length };
      }),
      count: jest.fn(async ({ where }: any) => rows.filter((r) => matches(r, where)).length),
    },
    $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(db) : Promise.all(arg))),
  };

  const config: any = {
    otpPepper: opts.pepper === undefined ? PEPPER : opts.pepper,
    otpTtlSeconds: 300,
    otpMaxAttempts: 5,
    otpResendCooldownSeconds: 60,
    otpMaxSendsPerWindow: 3,
    otpSendWindowSeconds: 900,
    otpMaxSendsPerDay: 10,
  };

  const audit: any = { record: jest.fn(async (p: Record<string, unknown>) => void audits.push(p)) };
  const service = new OtpService(db as never, config, audit, channel as never);
  return { service, rows, audits, channel: channel as TestWhatsAppChannel, db };
}

const base = { companyId: COMPANY, userId: USER, purpose: 'device_verification' as const, destination: PHONE };

describe('requesting a challenge', () => {
  it('creates one, delivers it and never returns the code', async () => {
    const { service, rows, channel } = makeHarness();

    const out = await service.request(base);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(rows).toHaveLength(1);
    expect(out.challenge.delivered).toBe(true);
    // The code is nowhere in the caller's view.
    expect(JSON.stringify(out.challenge)).not.toContain(channel.last!.variables.code);
    expect(out.challenge.destinationMasked).not.toContain('1234567');
  });

  it('stores only a hash — never the code', async () => {
    const { service, rows, channel } = makeHarness();
    await service.request(base);

    const code = channel.last!.variables.code;
    expect(rows[0].codeHash).not.toContain(code);
    expect(JSON.stringify(rows[0])).not.toContain(code);
  });

  it('refuses when no pepper is configured, rather than hashing weakly', async () => {
    const { service, rows } = makeHarness({ pepper: null });

    const out = await service.request(base);

    expect(out).toMatchObject({ ok: false, reason: 'otp_disabled' });
    expect(rows).toHaveLength(0);
  });

  it('records honest failure when no provider is configured', async () => {
    const { service, rows } = makeHarness({ channel: new DisabledWhatsAppChannel() });

    const out = await service.request(base);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The challenge exists, but nothing claims it was sent.
    expect(out.challenge.delivered).toBe(false);
    expect(out.challenge.delivery).toBe('channel_unavailable');
    expect(rows[0].providerMessageId).toBeNull();
  });

  it('supersedes a live challenge instead of leaving two codes valid', async () => {
    const { service, rows } = makeHarness();
    await service.request(base);
    const firstId = rows[0].id;

    await service.request(base);

    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id.equals(firstId))!.status).toBe('cancelled');
    // Only the live one keeps an active key — that is what the UNIQUE index guards.
    expect(rows.filter((r) => r.activeKey !== null)).toHaveLength(1);
  });

  it('reuses the challenge for a duplicate idempotency key — no second code', async () => {
    const { service, rows, channel } = makeHarness();
    const first = await service.request({ ...base, idempotencyKey: 'retry-1' });
    const second = await service.request({ ...base, idempotencyKey: 'retry-1' });

    expect(rows).toHaveLength(1);
    expect(channel.messages).toHaveLength(1);
    if (first.ok && second.ok) {
      expect(second.challenge.challengeId).toBe(first.challenge.challengeId);
    }
  });

  it('enforces the per-window send cap', async () => {
    const { service } = makeHarness();
    await service.request(base);
    await service.request(base);
    await service.request(base);

    const fourth = await service.request(base);

    expect(fourth).toMatchObject({ ok: false, reason: 'rate_limited' });
  });

  it('refuses with no destination', async () => {
    const { service } = makeHarness();
    expect(await service.request({ ...base, destination: '' })).toMatchObject({
      ok: false,
      reason: 'no_destination',
    });
  });
});

describe('verifying a code', () => {
  async function withChallenge() {
    const h = makeHarness();
    await h.service.request(base);
    return { ...h, code: h.channel.last!.variables.code, id: h.rows[0].id };
  }

  it('succeeds with the right code, exactly once', async () => {
    const { service, code, id } = await withChallenge();

    const first = await service.verify({ companyId: COMPANY, userId: USER, challengeId: id, code });
    const second = await service.verify({ companyId: COMPANY, userId: USER, challengeId: id, code });

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, reason: 'already_used' });
  });

  it('yields exactly one success under concurrent submissions', async () => {
    const { service, code, id } = await withChallenge();

    const results = await Promise.all([
      service.verify({ companyId: COMPANY, userId: USER, challengeId: id, code }),
      service.verify({ companyId: COMPANY, userId: USER, challengeId: id, code }),
      service.verify({ companyId: COMPANY, userId: USER, challengeId: id, code }),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('counts a wrong code and reports the attempts left', async () => {
    const { service, id, rows } = await withChallenge();

    const out = await service.verify({ companyId: COMPANY, userId: USER, challengeId: id, code: '999999' });

    expect(out).toMatchObject({ ok: false, reason: 'invalid_code', attemptsRemaining: 4 });
    expect(rows[0].attemptCount).toBe(1);
  });

  it('locks after the maximum attempts and stays locked', async () => {
    const { service, id, code, rows } = await withChallenge();

    for (let i = 0; i < 5; i++) {
      await service.verify({ companyId: COMPANY, userId: USER, challengeId: id, code: '999999' });
    }

    expect(rows[0].status).toBe('locked');
    // Even the correct code is refused now.
    expect(await service.verify({ companyId: COMPANY, userId: USER, challengeId: id, code })).toMatchObject({
      ok: false,
      reason: 'locked',
    });
  });

  it('rejects an expired code', async () => {
    const { service, id, code, rows } = await withChallenge();
    rows[0].expiresAt = new Date(Date.now() - 1000);

    expect(await service.verify({ companyId: COMPANY, userId: USER, challengeId: id, code })).toMatchObject({
      ok: false,
      reason: 'expired',
    });
    expect(rows[0].status).toBe('expired');
  });

  it('rejects a cancelled challenge', async () => {
    const { service, id, code } = await withChallenge();
    await service.cancel(id);

    expect(await service.verify({ companyId: COMPANY, userId: USER, challengeId: id, code })).toMatchObject({
      ok: false,
      reason: 'cancelled',
    });
  });

  it("another company's challenge is simply not found", async () => {
    const { service, id, code } = await withChallenge();

    expect(
      await service.verify({ companyId: OTHER_COMPANY, userId: USER, challengeId: id, code }),
    ).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it("another user's challenge is simply not found", async () => {
    const { service, id, code } = await withChallenge();

    expect(
      await service.verify({ companyId: COMPANY, userId: OTHER_USER, challengeId: id, code }),
    ).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('never puts the code or the hash in an audit entry', async () => {
    const { service, id, code, audits, rows } = await withChallenge();
    await service.verify({ companyId: COMPANY, userId: USER, challengeId: id, code });

    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain(code);
    expect(serialized).not.toContain(rows[0].codeHash);
    expect(serialized).not.toContain(PEPPER);
    // And the destination is masked wherever it appears.
    expect(serialized).not.toContain(PHONE);
  });
});

describe('resend', () => {
  it('is refused inside the cooldown', async () => {
    const { service, rows } = makeHarness();
    await service.request(base);

    const out = await service.resend({ companyId: COMPANY, userId: USER, challengeId: rows[0].id });

    expect(out).toMatchObject({ ok: false, reason: 'rate_limited' });
  });

  it('replaces the old code once the cooldown passes', async () => {
    const { service, rows, channel } = makeHarness();
    await service.request(base);
    const firstId = rows[0].id;
    const firstCode = channel.last!.variables.code;
    rows[0].resendNotBefore = new Date(Date.now() - 1000);

    const out = await service.resend({ companyId: COMPANY, userId: USER, challengeId: firstId });

    expect(out.ok).toBe(true);
    // The old challenge is dead, so the old code cannot still work.
    expect(rows.find((r) => r.id.equals(firstId))!.status).toBe('cancelled');
    const stale = await service.verify({
      companyId: COMPANY,
      userId: USER,
      challengeId: firstId,
      code: firstCode,
    });
    expect(stale.ok).toBe(false);
  });
});

describe('verification intent', () => {
  function intentHarness() {
    const rows: Record<string, any>[] = [];
    const db: any = {
      verificationIntent: {
        create: jest.fn(async ({ data }: any) => {
          rows.push({ consumedAt: null, ...data });
          return data;
        }),
        findUnique: jest.fn(async ({ where }: any) =>
          rows.find((r) => r.tokenHash === where.tokenHash) ?? null,
        ),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const hits = rows.filter(
            (r) => r.id.equals(where.id) && (where.consumedAt !== null || r.consumedAt === null),
          );
          for (const h of hits) Object.assign(h, data);
          return { count: hits.length };
        }),
        deleteMany: jest.fn(async () => ({ count: 0 })),
      },
      $transaction: jest.fn(async (fn: any) => fn(db)),
    };
    return { service: new VerificationIntentService(db as never), rows };
  }

  const issueArgs = {
    companyId: COMPANY,
    userId: USER,
    purpose: 'device_verification' as never,
    deviceId: null,
  };

  it('stores only the token hash', async () => {
    const { service, rows } = intentHarness();

    const issued = await service.issue(issueArgs);

    expect(issued.token).toEqual(expect.any(String));
    expect(rows[0].tokenHash).not.toContain(issued.token);
    expect(JSON.stringify(rows[0])).not.toContain(issued.token);
  });

  it('resolves with the right token', async () => {
    const { service } = intentHarness();
    const issued = await service.issue(issueArgs);

    expect(await service.resolve(issued.token, { companyId: COMPANY, userId: USER })).toMatchObject({
      ok: true,
    });
  });

  it('rejects a wrong token', async () => {
    const { service } = intentHarness();
    await service.issue(issueArgs);

    expect(await service.resolve('not-the-token')).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('rejects an expired token', async () => {
    const { service, rows } = intentHarness();
    const issued = await service.issue(issueArgs);
    rows[0].expiresAt = new Date(Date.now() - 1000);

    expect(await service.resolve(issued.token)).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('rejects cross-company, cross-user and cross-device use identically', async () => {
    const { service } = intentHarness();
    const issued = await service.issue(issueArgs);

    // One reason for all of them, so a caller cannot probe which part was wrong.
    expect(await service.resolve(issued.token, { companyId: OTHER_COMPANY })).toMatchObject({
      ok: false,
      reason: 'mismatch',
    });
    expect(await service.resolve(issued.token, { userId: OTHER_USER })).toMatchObject({
      ok: false,
      reason: 'mismatch',
    });
    expect(await service.resolve(issued.token, { deviceId: newUuidV7Bin() })).toMatchObject({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('can be consumed exactly once, atomically with its work', async () => {
    const { service, rows } = intentHarness();
    const issued = await service.issue(issueArgs);
    const resolved = await service.resolve(issued.token);
    if (!resolved.ok) throw new Error('expected resolvable');

    const done: string[] = [];
    const first = await service.consume(resolved.intentId, async () => {
      done.push('work');
      return 'ok';
    });
    const second = await service.consume(resolved.intentId, async () => {
      done.push('work-again');
      return 'ok';
    });

    expect(first).toMatchObject({ ok: true, result: 'ok' });
    expect(second).toMatchObject({ ok: false, reason: 'consumed' });
    // The second caller's work must not have run.
    expect(done).toEqual(['work']);
    expect(rows[0].consumedAt).toBeInstanceOf(Date);
  });

  it('refuses a consumed token on resolve', async () => {
    const { service, rows } = intentHarness();
    const issued = await service.issue(issueArgs);
    rows[0].consumedAt = new Date();

    expect(await service.resolve(issued.token)).toMatchObject({ ok: false, reason: 'consumed' });
  });

  it('issues no session or token of authority by itself', async () => {
    const { service } = intentHarness();
    const issued = await service.issue(issueArgs);

    // The whole shape: a ticket and an expiry. No access token, no refresh
    // token, no session id — that is the point of it existing.
    expect(Object.keys(issued).sort()).toEqual(['expiresAt', 'intentId', 'token']);
    expect(binToUuid(uuidToBin(issued.intentId))).toBe(issued.intentId);
  });
});
