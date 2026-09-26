import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ClosingService } from './closing.service';
import { dateValue } from '../common/business-day/business-day.service';

/**
 * "Open the boutique" before 06:00 (docs/56): the business date is still the
 * previous calendar day, so the opening says which day was chosen — `continue`
 * opens that day, `start_new` (the Owner alone) starts the next date and opens
 * it. Nothing already recorded moves; a plain opening after 06:00 claims no
 * choice. The service is driven with a mocked database, so what is asserted
 * is exactly what would be written.
 */

const branchId = Buffer.from('01a091c77f1e7f5db52a64ee21b95896', 'hex');
const companyId = Buffer.from('01a091c77eac76ada3384092cc1e12e4', 'hex');
const userId = Buffer.from('01a091c77f2b764da36774d37794e74f', 'hex');

/** 03:41 on the 26th: the calendar has moved on, the business date has not. */
const before6 = { businessDate: '2026-09-25', localDate: '2026-09-26', timezone: 'UTC', canStartEarly: true, startedEarly: false };
/** The same moment once the 26th was started early. */
const startedEarly = { ...before6, businessDate: '2026-09-26', canStartEarly: false, startedEarly: true };
/** 09:00 on the 26th: nothing to choose. */
const after6 = { businessDate: '2026-09-26', localDate: '2026-09-26', timezone: 'UTC', canStartEarly: false, startedEarly: false };

function build(descriptions: object[], opts: { mayStartEarly?: boolean; events?: { kind: string }[]; row?: { id: Buffer; status: string } | null } = {}) {
  const describe = jest.fn();
  for (const d of descriptions) describe.mockResolvedValueOnce(d);
  const db = {
    dailyClosing: { findUnique: jest.fn().mockResolvedValue(opts.row ?? null) },
    closingEvent: { findMany: jest.fn().mockResolvedValue(opts.events ?? []), create: jest.fn().mockResolvedValue({}) },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const permissions = new Set(['closing.count', ...(opts.mayStartEarly ? ['closing.start_early'] : [])]);
  const svc = Object.create(ClosingService.prototype) as ClosingService & Record<string, unknown>;
  Object.assign(svc, {
    db,
    audit,
    tenant: { companyId: () => companyId, requireBranchId: () => branchId, userId: () => userId },
    cls: { get: (key: string) => (key === 'permissions' ? permissions : undefined) },
    businessDay: { describe },
    openView: jest.fn(async (day: string) => ({ view: day })),
  });
  return { svc, db, audit, describe };
}

const created = (db: ReturnType<typeof build>['db']) => db.closingEvent.create.mock.calls.map((c) => c[0].data);

describe('Open the boutique before 06:00 (docs/56)', () => {
  it('a start_new from somebody without closing.start_early is refused before anything is written', async () => {
    const { svc, db, audit } = build([before6]);
    await expect(svc.open({ mode: 'start_new' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.closingEvent.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('a start_new after 06:00 is refused by name: not_before_day_start', async () => {
    const { svc, db } = build([after6], { mayStartEarly: true });
    const refusal = await svc.open({ mode: 'start_new' }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as ConflictException).getResponse()).toMatchObject({ code: 'not_before_day_start' });
    expect(db.closingEvent.create).not.toHaveBeenCalled();
  });

  it('the Owner’s start_new at 03:41 starts the 26th and opens it: two events, two audit rows, the choice on record', async () => {
    const { svc, db, audit, describe } = build([before6, startedEarly], { mayStartEarly: true });
    const view = await svc.open({ mode: 'start_new' });
    const [early, opened] = created(db);
    expect(early).toMatchObject({ kind: 'day_started_early', businessDate: dateValue('2026-09-26'), actorId: userId, closingId: null });
    expect(early.payload).toMatchObject({ previousDate: '2026-09-25' });
    expect(opened).toMatchObject({ kind: 'opened', businessDate: dateValue('2026-09-26'), actorId: userId });
    expect(opened.payload).toMatchObject({ nth: 1, choice: 'start_new', calendarDate: '2026-09-26', localTime: expect.stringMatching(/^\d\d:\d\d$/) });
    expect(audit.record.mock.calls.map((c) => c[0].reason)).toEqual(['day_started_early', 'opened']);
    expect(audit.record.mock.calls[1][0].after).toMatchObject({ businessDate: '2026-09-26', choice: 'start_new' });
    // The business day was described again after the start, and the new day is what is opened and returned.
    expect(describe).toHaveBeenCalledTimes(2);
    expect(view).toEqual({ view: '2026-09-26' });
  });

  it('continue at 03:41 opens the 25th — the previous business day — and records that it was chosen', async () => {
    const { svc, db, audit } = build([before6], { mayStartEarly: true });
    const view = await svc.open({ mode: 'continue' });
    const events = created(db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'opened', businessDate: dateValue('2026-09-25') });
    expect(events[0].payload).toMatchObject({ nth: 1, choice: 'continue', calendarDate: '2026-09-26' });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(view).toEqual({ view: '2026-09-25' });
  });

  it('an opening with no mode before 06:00 — a staff member’s — is the previous day, and says so', async () => {
    const { svc, db } = build([before6]);
    await svc.open({});
    expect(created(db)[0]).toMatchObject({ kind: 'opened', businessDate: dateValue('2026-09-25') });
    expect(created(db)[0].payload).toMatchObject({ choice: 'continue', calendarDate: '2026-09-26' });
  });

  it('after 06:00 an opening claims no choice at all', async () => {
    const { svc, db } = build([after6]);
    await svc.open({});
    const [opened] = created(db);
    expect(opened).toMatchObject({ kind: 'opened', businessDate: dateValue('2026-09-26') });
    expect(opened.payload).not.toHaveProperty('choice');
    expect(opened.payload).not.toHaveProperty('calendarDate');
  });

  it('a second start_new once the day was started early starts nothing twice and opens the new day', async () => {
    const { svc, db, describe } = build([startedEarly], { mayStartEarly: true });
    await svc.open({ mode: 'start_new' });
    const events = created(db);
    expect(events.map((e) => e.kind)).toEqual(['opened']);
    expect(events[0]).toMatchObject({ businessDate: dateValue('2026-09-26') });
    expect(describe).toHaveBeenCalledTimes(1);
  });

  it('a repeat tap on an open day is refused as open_already_open and writes nothing', async () => {
    const { svc, db } = build([before6], { mayStartEarly: true, events: [{ kind: 'opened' }] });
    const refusal = await svc.open({ mode: 'continue' }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as ConflictException).getResponse()).toMatchObject({ code: 'open_already_open' });
    expect(db.closingEvent.create).not.toHaveBeenCalled();
  });

  it('a closed previous day is not opened but reopened — refused by name, with the choice left to the reopen', async () => {
    const { svc, db } = build([before6], { mayStartEarly: true, row: { id: Buffer.alloc(16), status: 'locked' } });
    const refusal = await svc.open({ mode: 'continue' }).catch((e: unknown) => e);
    expect((refusal as ConflictException).getResponse()).toMatchObject({ code: 'open_day_closed' });
    expect(db.closingEvent.create).not.toHaveBeenCalled();
  });
});
