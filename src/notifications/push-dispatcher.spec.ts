import { uuidToBin } from '../common/utils/uuid.util';
import { ExpoPushProvider, planPushes, type PlanInput } from './push-dispatcher';
import { pushCopy } from './push-copy';

/** Who is pushed, on which phone, in which language (D225). */

const id = (n: number) => uuidToBin(`00000000-0000-7000-8000-${String(n).padStart(12, '0')}`);
const OWNER = id(1);
const MANAGER = id(2);
const SELLER = id(3);

function input(type: string, over: Partial<PlanInput> = {}): PlanInput {
  return {
    notification: { id: id(100), type, actionLink: '/returns/x', actorUserId: SELLER },
    storeName: { name: 'Tevragh Zeina', nameAr: 'تفرغ زينة' },
    audience: [
      { userId: OWNER, level: 'important' },
      { userId: MANAGER, level: 'approvals' },
      { userId: SELLER, level: 'all' },
    ],
    devices: [
      { id: id(10), userId: OWNER, token: 'ExponentPushToken[owner-fr]', locale: 'fr' },
      { id: id(11), userId: OWNER, token: 'ExponentPushToken[owner-ar]', locale: 'ar' },
      { id: id(12), userId: MANAGER, token: 'ExponentPushToken[manager]', locale: 'en' },
      { id: id(13), userId: SELLER, token: 'ExponentPushToken[seller]', locale: 'ar' },
    ],
    ...over,
  };
}

const tokens = (i: PlanInput) => planPushes(i).map((m) => m.token);

it('a routine sale is pushed to nobody under Important or Approvals only, and never to its seller', () => {
  expect(tokens(input('sale.recorded'))).toEqual([]);
});

it('a return to review reaches the Owner on both phones and the Manager (approval), not the seller who asked', () => {
  expect(tokens(input('return.requested')).sort()).toEqual(['ExponentPushToken[manager]', 'ExponentPushToken[owner-ar]', 'ExponentPushToken[owner-fr]']);
});

it('each phone is told in its own language, the store in that language too', () => {
  const byToken = Object.fromEntries(planPushes(input('return.requested')).map((m) => [m.token, m]));
  expect(byToken['ExponentPushToken[owner-fr]'].title).toBe('Retour à examiner');
  expect(byToken['ExponentPushToken[owner-ar]'].title).toBe('مرتجع للمراجعة');
  expect(byToken['ExponentPushToken[owner-ar]'].body).toContain('تفرغ زينة');
  expect(byToken['ExponentPushToken[manager]'].title).toBe('Return to review');
  expect(byToken['ExponentPushToken[manager]'].body).toContain('Tevragh Zeina');
});

it('carries ids for the deep link and no figure or private text', () => {
  const [m] = planPushes(input('return.requested'));
  expect(m.data).toEqual({ notificationId: expect.any(String), type: 'return.requested', link: '/returns/x' });
  // What the lock screen shows names the kind of event and the store — no amount, no invoice, no identifier.
  expect(`${m.title} ${m.body}`).not.toMatch(/\d/);
});

it('nobody outside the audience is ever pushed: a device of somebody not in it is ignored', () => {
  const plan = input('return.requested', { audience: [{ userId: MANAGER, level: 'all' }] });
  expect(tokens(plan)).toEqual(['ExponentPushToken[manager]']);
});

it('All activity pushes the routine sale to everyone but the seller', () => {
  const plan = input('sale.recorded', { audience: [{ userId: OWNER, level: 'all' }, { userId: SELLER, level: 'all' }] });
  expect(tokens(plan).sort()).toEqual(['ExponentPushToken[owner-ar]', 'ExponentPushToken[owner-fr]']);
});

it('the copy has a sentence for every language, and a generic one for a type without its own', () => {
  for (const locale of ['en', 'fr', 'ar'] as const) expect(pushCopy('something.new', locale, null).title.length).toBeGreaterThan(0);
  expect(pushCopy('acting_owner.appointed', 'ar', null).title).toBe('تم تعيين مالك بالنيابة');
});

describe('the Expo provider', () => {
  const msg = planPushes(input('return.requested'));
  it('maps each answer to sent or a short error code', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }, { status: 'error', details: { error: 'DeviceNotRegistered' } }, { status: 'ok' }] }),
    }));
    const out = await new ExpoPushProvider(fetchImpl as never).send(msg);
    expect(out).toEqual([{ ok: true }, { ok: false, error: 'DeviceNotRegistered' }, { ok: true }]);
  });

  it('a network failure or an HTTP error fails every message, without throwing', async () => {
    expect(await new ExpoPushProvider((async () => { throw new Error('offline'); }) as never).send(msg)).toEqual(msg.map(() => ({ ok: false, error: 'network' })));
    expect(await new ExpoPushProvider((async () => ({ ok: false, status: 503 })) as never).send(msg)).toEqual(msg.map(() => ({ ok: false, error: 'http_503' })));
  });
});
