import {
  ACKNOWLEDGEMENT_TTL_SECONDS,
  fingerprintWarnings,
  issueAcknowledgement,
  normalizePayload,
  verifyAcknowledgement,
  type AcknowledgementSubject,
} from './acknowledgement';
import type { Warning } from './warning.types';

/**
 * "Yes, I meant that" — and what exactly it was attached to.
 *
 * The failure this design exists to prevent: a user confirms a price of
 * 170 000, and the confirmation is then good for 1 700 000 as well. A boolean
 * in the body authorises nothing, and a per-user flag is worse than nothing —
 * it looks like a control while covering a request nobody looked at.
 */

const ORIGINAL_SECRET = process.env.JWT_ACCESS_SECRET;
beforeAll(() => {
  process.env.JWT_ACCESS_SECRET = 'test-secret-that-is-at-least-32-chars-long';
});
afterAll(() => {
  process.env.JWT_ACCESS_SECRET = ORIGINAL_SECRET;
});

const SUBJECT: AcknowledgementSubject = {
  actorId: '018f0000-0000-7000-8000-00000000000a',
  companyId: '018f0000-0000-7000-8000-000000000001',
  branchId: '018f0000-0000-7000-8000-0000000000b1',
  operation: 'sale.create',
};

const PAYLOAD = { lines: [{ unitId: 'u1', price: 170000 }], customerId: null };

const WARNINGS: Warning[] = [
  {
    code: 'magnitude.sale_price',
    severity: 'caution',
    messageKey: 'warning.magnitude.salePrice',
    params: { factor: 10 },
    field: 'lines.0.price',
    submitted: 170000,
    reference: { kind: 'configured_price', amount: 17000, sample: null },
  },
];

const issue = (payload: unknown = PAYLOAD, warnings = WARNINGS, subject = SUBJECT) =>
  issueAcknowledgement(subject, payload, warnings);

const verify = (
  token: string,
  payload: unknown = PAYLOAD,
  warnings = WARNINGS,
  subject = SUBJECT,
  now = new Date(),
) => verifyAcknowledgement(token, subject, payload, warnings, now);

describe('a matching acknowledgement', () => {
  it('authorises the exact request it was issued for', () => {
    expect(verify(issue().token)).toEqual({ ok: true });
  });

  it('does not care about key order in the payload', () => {
    // Two clients serialising the same intent differently must agree.
    const { token } = issue({ b: 2, a: 1, nested: { y: 1, x: 2 } });
    expect(verify(token, { a: 1, nested: { x: 2, y: 1 }, b: 2 })).toEqual({ ok: true });
  });

  it('treats an absent field and an undefined one as the same', () => {
    const { token } = issue({ a: 1 });
    expect(verify(token, { a: 1, b: undefined })).toEqual({ ok: true });
  });

  it('expires', () => {
    const { token, expiresAt } = issue();
    const justBefore = new Date(expiresAt.getTime() - 1000);
    const justAfter = new Date(expiresAt.getTime() + 1000);
    expect(verify(token, PAYLOAD, WARNINGS, SUBJECT, justBefore)).toEqual({ ok: true });
    expect(verify(token, PAYLOAD, WARNINGS, SUBJECT, justAfter)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('lives ten minutes, not hours', () => {
    // Short enough that a token copied out of a log is worthless before anybody
    // finds it; long enough to read a dialog and decide.
    expect(ACKNOWLEDGEMENT_TTL_SECONDS).toBe(600);
  });
});

describe('the failure this exists to prevent', () => {
  it('does not carry over to a different amount', () => {
    /*
     * The whole point. Confirm 170 000, then submit 1 700 000 with the same
     * token: the acknowledgement means THIS request, not "this user has been
     * warned before".
     */
    const { token } = issue({ lines: [{ unitId: 'u1', price: 170000 }] });
    expect(verify(token, { lines: [{ unitId: 'u1', price: 1700000 }] })).toEqual({
      ok: false,
      reason: 'payload_changed',
    });
  });

  it('does not carry over to a different unit at the same price', () => {
    const { token } = issue({ lines: [{ unitId: 'u1', price: 170000 }] });
    expect(verify(token, { lines: [{ unitId: 'u2', price: 170000 }] })).toEqual({
      ok: false,
      reason: 'payload_changed',
    });
  });

  it('does not cover a warning the user never saw', () => {
    /*
     * The offline-replay case. A queued request comes back after the world
     * moved, and the server now raises something different. The user has not
     * seen it, so their earlier confirmation does not cover it — `docs/32`'s
     * rule is that such an item pauses for a human.
     */
    const { token } = issue();
    const different: Warning[] = [{ ...WARNINGS[0], code: 'magnitude.intake_cost' }];
    expect(verify(token, PAYLOAD, different)).toEqual({ ok: false, reason: 'warnings_changed' });
  });

  it('does not cover an ADDITIONAL warning on the same request', () => {
    const { token } = issue();
    const more: Warning[] = [...WARNINGS, { ...WARNINGS[0], field: 'lines.1.price' }];
    expect(verify(token, PAYLOAD, more)).toEqual({ ok: false, reason: 'warnings_changed' });
  });

  it('tolerates a reference figure drifting between the two requests', () => {
    /*
     * A median that moved by one unit is the same warning about the same thing.
     * Forcing a re-confirmation for it would train people to click through,
     * which is how a warning stops working.
     */
    const { token } = issue();
    const drifted: Warning[] = [
      { ...WARNINGS[0], reference: { kind: 'configured_price', amount: 17050, sample: null } },
    ];
    expect(verify(token, PAYLOAD, drifted)).toEqual({ ok: true });
  });
});

describe('who and where', () => {
  it('is one person\'s confirmation, not anybody\'s', () => {
    const { token } = issue();
    const someoneElse = { ...SUBJECT, actorId: '018f0000-0000-7000-8000-00000000000b' };
    expect(verify(token, PAYLOAD, WARNINGS, someoneElse)).toEqual({
      ok: false,
      reason: 'wrong_actor',
    });
  });

  it('does not cross companies', () => {
    const { token } = issue();
    const otherCompany = { ...SUBJECT, companyId: '018f0000-0000-7000-8000-000000000002' };
    expect(verify(token, PAYLOAD, WARNINGS, otherCompany)).toEqual({
      ok: false,
      reason: 'wrong_tenant',
    });
  });

  it('does not cross branches, even for a user who holds both', () => {
    const { token } = issue();
    const otherBranch = { ...SUBJECT, branchId: '018f0000-0000-7000-8000-0000000000b2' };
    expect(verify(token, PAYLOAD, WARNINGS, otherBranch)).toEqual({
      ok: false,
      reason: 'wrong_tenant',
    });
  });

  it('does not cross operations', () => {
    // A confirmation for a sale is not a confirmation for an intake.
    const { token } = issue();
    expect(verify(token, PAYLOAD, WARNINGS, { ...SUBJECT, operation: 'unit.intake' })).toEqual({
      ok: false,
      reason: 'wrong_operation',
    });
  });
});

describe('the token cannot be forged', () => {
  /** Rewrite one claim and re-encode, leaving the original signature. */
  const tamper = (token: string, change: Record<string, unknown>): string => {
    const split = token.lastIndexOf('.');
    const claims = JSON.parse(Buffer.from(token.slice(0, split), 'base64url').toString('utf8'));
    const body = Buffer.from(JSON.stringify({ ...claims, ...change }), 'utf8').toString('base64url');
    return `${body}.${token.slice(split + 1)}`;
  };

  it('refuses a tampered claim', () => {
    const forged = tamper(issue().token, { actorId: '018f0000-0000-7000-8000-00000000000b' });
    expect(verify(forged)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a tampered expiry', () => {
    const forged = tamper(issue().token, { expiresAt: Date.now() + 86_400_000 });
    expect(verify(forged)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('checks the signature BEFORE decoding any claim', () => {
    /*
     * Order matters. Parsing a claim out of an unverified token and acting on
     * it — even to reject — is acting on an attacker's data, and it reports a
     * forgery as "wrong actor", which reads like a permission problem rather
     * than an attack.
     */
    const forged = tamper(issue().token, { actorId: 'somebody-else', expiresAt: 1 });
    expect(verify(forged)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('survives an operation name containing a dot', () => {
    /*
     * The bug the first version shipped with. Claims were joined by dots and
     * `operation` is `sale.create`, so every valid token split into the wrong
     * number of parts and read as malformed. A separator that can appear inside
     * a claim is not a separator.
     */
    expect(SUBJECT.operation).toContain('.');
    expect(verify(issue().token)).toEqual({ ok: true });
  });

  it.each(['', 'nonsense', 'a.b', 'not-base64url.signature'])(
    'refuses the malformed token %p',
    (token) => {
      expect(verify(token).ok).toBe(false);
    },
  );

  it('refuses a missing token', () => {
    expect(verifyAcknowledgement(undefined, SUBJECT, PAYLOAD, WARNINGS)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('does not verify with a different signing secret', () => {
    // Rotating JWT_ACCESS_SECRET invalidates outstanding acknowledgements. That
    // is correct, and costs a user one re-confirmation.
    const { token } = issue();
    const previous = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = 'a-completely-different-secret-32-chars';
    try {
      expect(verify(token)).toEqual({ ok: false, reason: 'bad_signature' });
    } finally {
      process.env.JWT_ACCESS_SECRET = previous;
    }
  });
});

describe('the pieces', () => {
  it('normalizes a payload stably', () => {
    expect(normalizePayload({ b: 1, a: 2 })).toBe(normalizePayload({ a: 2, b: 1 }));
    expect(normalizePayload([1, 2])).not.toBe(normalizePayload([2, 1]));
  });

  it('fingerprints warnings by code and field, order-independently', () => {
    const a: Warning[] = [WARNINGS[0], { ...WARNINGS[0], code: 'magnitude.intake_cost' }];
    const b: Warning[] = [a[1], a[0]];
    expect(fingerprintWarnings(a)).toBe(fingerprintWarnings(b));
  });

  it('distinguishes the same warning on two different fields', () => {
    const a: Warning[] = [WARNINGS[0]];
    const b: Warning[] = [{ ...WARNINGS[0], field: 'lines.1.price' }];
    expect(fingerprintWarnings(a)).not.toBe(fingerprintWarnings(b));
  });

  it('an empty warning set is its own fingerprint', () => {
    expect(fingerprintWarnings([])).toBe('');
    expect(fingerprintWarnings([])).not.toBe(fingerprintWarnings(WARNINGS));
  });
});

describe('the token carries nothing sensitive', () => {
  it('is claims and a signature, with no figures in it', () => {
    /*
     * A token travels to the client and back, and may end up in a log despite
     * the scrubber. It must not be a place a price or a cost can leak.
     */
    const { token } = issue();
    const [body] = token.split('.');
    const claims = Buffer.from(body, 'base64url').toString('utf8');
    expect(claims).not.toContain('170000');
    expect(claims).not.toContain('17000');
    // The payload is a HASH in the claims, never the values themselves.
    expect(JSON.parse(claims).payloadHash).toEqual(expect.any(String));
  });
});
