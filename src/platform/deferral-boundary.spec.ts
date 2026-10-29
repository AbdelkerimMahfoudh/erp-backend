import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RegisterDto, ContinueConfirmDto } from './registration.dto';
import { CreateStaffDto, StaffJoinConfirmDto } from '../staff/dto/staff.dto';
import { UpdateUserDto } from '../users/dto/update-user.dto';
import { ConfirmPhoneVerificationDto, StartPhoneVerificationDto } from '../account/account.dto';
import { AcceptInvitationDto, CreateBusinessDto } from './platform.controller';

/**
 * Deferred verification is the platform console's alone (D224, docs/109 §2.3). Public registration and every tenant
 * route — an Owner's, a Manager's, an Employee's — have no such field: the API's own pipe (main.ts) rejects one sent,
 * and no tenant code path writes the state.
 */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } });
const SPOOF = { verification: 'deferred_by_platform', phoneVerification: 'deferred_by_platform', deferral: { reason: 'x', confirmUnverified: true } };

async function refused(metatype: new () => object, body: object) {
  return pipe.transform({ ...body, ...SPOOF }, { type: 'body', metatype }).then(
    () => null,
    (e: unknown) => e,
  );
}

describe('no route but the console can ask for a deferral', () => {
  const cases: [string, new () => object, object][] = [
    ['public registration', RegisterDto, { idempotencyKey: 'k-1-aaaaaaaa', ownerName: 'A', businessName: 'B', email: 'a@example.test', password: 'password-1', language: 'en' }],
    ['registration continuation', ContinueConfirmDto, {}],
    ['an Owner adding staff from Team', CreateStaffDto, { name: 'N', phone: '+22243210987', role: 'store_employee', branchIds: [] }],
    ['an employee activating their invitation', StaffJoinConfirmDto, { reference: 'K7QM-9XRT-2CHD', code: '123456' }],
    ['editing a user', UpdateUserDto, {}],
    ['a person verifying their own number', StartPhoneVerificationDto, {}],
    ['a person confirming their own number', ConfirmPhoneVerificationDto, {}],
    ['spending a setup code', AcceptInvitationDto, { token: 'a'.repeat(32), password: 'password-1' }],
  ];
  for (const [name, dto, body] of cases) {
    it(`${name}: the field is rejected, never ignored`, async () => {
      const e = await refused(dto, body);
      expect(e).toBeInstanceOf(BadRequestException);
      const messages = JSON.stringify((e as BadRequestException).getResponse());
      expect(messages).toMatch(/property (verification|phoneVerification|deferral) should not exist/);
    });
  }

  it('the console’s business creation accepts it, and only its two values', async () => {
    const base = { idempotencyKey: 'console-key-1', ownerName: 'O', businessName: 'B', phone: '+22243210987', language: 'en', isTest: true, reason: 'pilot', confirmPassword: 'p' };
    const ok = await pipe.transform({ ...base, verification: 'deferred_by_platform', deferral: { reason: 'r', confirmUnverified: true } }, { type: 'body', metatype: CreateBusinessDto });
    expect(ok).toMatchObject({ verification: 'deferred_by_platform' });
    await expect(pipe.transform({ ...base, verification: 'verified' }, { type: 'body', metatype: CreateBusinessDto })).rejects.toBeInstanceOf(BadRequestException);
    // The confirmation is a real `true`, never assumed.
    await expect(pipe.transform({ ...base, verification: 'deferred_by_platform', deferral: { reason: 'r', confirmUnverified: false } }, { type: 'body', metatype: CreateBusinessDto })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('no tenant or public code writes the deferred state: only the console’s provisioning does', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.spec.ts') && !p.includes('__testing__') && !p.includes(`${join('', 'testing')}`)) files.push(p);
      }
    };
    walk(join(__dirname, '..'));
    const writers = files.filter((p) => /phoneVerification:\s*'deferred_by_platform'/.test(readFileSync(p, 'utf8')) && /\b(create|update|updateMany)\(/.test(readFileSync(p, 'utf8')));
    expect(writers.map((p) => p.slice(p.lastIndexOf('src')).replace(/\\/g, '/')).sort()).toEqual(['src/platform/account-provisioning.service.ts']);
  });
});
