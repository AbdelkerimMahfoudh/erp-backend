import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateBusinessDto } from '../platform/platform.controller';
import { RegisterDto } from '../platform/registration.dto';
import { UpdateNamesDto } from '../names/dto/update-names.dto';
import { receiptNamesOf } from '../sales/sales.service';
import {
  LEGACY_OLDEST_STORE,
  adminAccountLabel,
  legacyLabel,
  legacyLabelAr,
  neutralAccount,
  participantLabel,
  participantLabelAr,
  storesOfUser,
  storesText,
  storesTextAr,
} from './account-label';

/** An account needs no company name (D227), and what people read depends on what they are reading about. */
const CENTRE = { name: 'Boutique Centre', nameAr: 'متجر المركز' };
const PORT = { name: 'Boutique Port', nameAr: null };

describe('something about one store names that store', () => {
  it('the exact store, not another of the same Owner, when there is no trading name', () => {
    expect(participantLabel({ name: null }, PORT)).toBe('Boutique Port');
    expect(participantLabel({ name: null }, CENTRE)).toBe('Boutique Centre');
    expect(participantLabelAr({ name: null }, CENTRE)).toBe('متجر المركز');
  });

  it('the trading name when there is one', () => {
    expect(participantLabel({ name: 'SARL Kiffa' }, PORT)).toBe('SARL Kiffa');
    expect(participantLabelAr({ name: 'SARL Kiffa', nameAr: null }, CENTRE)).toBeNull();
  });

  it('nothing rather than a placeholder', () => {
    expect(participantLabel({ name: null }, null)).toBe('');
  });
});

describe('something about the whole account is neutral', () => {
  it.each([
    ['en', 'your Dukan account', 'Your Dukan account'],
    ['fr', 'votre compte Dukan', 'Votre compte Dukan'],
    ['ar', 'حسابك في دكان', 'حسابك في دكان'],
  ] as const)('%s', (language, within, opening) => {
    expect(neutralAccount(language)).toBe(within);
    expect(neutralAccount(language, true)).toBe(opening);
  });
});

describe('the stores a person may choose among', () => {
  it('are theirs, active, in a stable order', async () => {
    const asked: unknown[] = [];
    const db = {
      userBranch: {
        findMany: async (args: unknown) => {
          asked.push(args);
          return [{ branch: CENTRE }, { branch: PORT }];
        },
      },
    };
    const user = Buffer.alloc(16, 7);
    expect(await storesOfUser(db as never, user)).toEqual([CENTRE, PORT]);
    expect(asked[0]).toMatchObject({ where: { userId: user, branch: { isActive: true } }, orderBy: [{ id: 'asc' }] });
  });

  it('are written out for an older build, every one of them', () => {
    expect(storesText([CENTRE, PORT])).toBe('Boutique Centre, Boutique Port');
    expect(storesTextAr([CENTRE, PORT])).toBe('متجر المركز، Boutique Port');
    expect(storesTextAr([PORT])).toBeNull();
  });
});

describe('the console’s label, presentation only', () => {
  it('one store, several, and the exceptional account with none', () => {
    expect(adminAccountLabel('Aicha', [CENTRE])).toEqual({ owner: 'Aicha', store: 'Boutique Centre', moreStores: 0 });
    expect(adminAccountLabel('Aicha', [CENTRE, PORT, PORT])).toEqual({ owner: 'Aicha', store: 'Boutique Centre', moreStores: 2 });
    expect(adminAccountLabel('Aicha', [])).toEqual({ owner: 'Aicha', store: null, moreStores: 0 });
  });
});

describe('the one legacy path, a connection', () => {
  it('asks in an explicit, stable order, and only for active stores', () => {
    expect(LEGACY_OLDEST_STORE.branches).toMatchObject({ where: { isActive: true }, take: 1, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    expect(legacyLabel({ name: null, branches: [CENTRE] })).toBe('Boutique Centre');
    expect(legacyLabelAr({ name: 'SARL', nameAr: null, branches: [CENTRE] })).toBeNull();
    expect(legacyLabel({ name: null, branches: [] })).toBe('');
  });
});

describe('source scan: no store is ever picked arbitrarily', () => {
  const ROOT = join(__dirname, '..');
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return sources(p);
      return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [p] : [];
    });
  const rel = (f: string) => relative(ROOT, f).split(sep).join('/');
  const all = sources(ROOT).map((f) => [rel(f), readFileSync(f, 'utf8')] as const);

  it('the legacy fallback is used for connections alone', () => {
    const users = all.filter(([f, s]) => f !== 'common/account-label.ts' && /LEGACY_OLDEST_STORE|legacyLabel/.test(s)).map(([f]) => f).sort();
    expect(users).toEqual(['consignment/connections.service.ts', 'consignment/discovery.ts']);
  });

  it('no account is named from the first of an array of stores', () => {
    const offending = all.filter(([f, s]) => f !== 'common/account-label.ts' && /\bbranches\??\.?\[0\]\??\.name/.test(s)).map(([f]) => f);
    expect(offending).toEqual([]);
  });

  it('every read of one branch for its name is ordered, or by its own id', () => {
    const unordered = all.flatMap(([f, s]) =>
      [...s.matchAll(/\.branch\.findFirst\(\{([\s\S]*?)\}\);/g)]
        .filter((m) => /select:\s*\{[^}]*\bname: true/.test(m[1]) && !/orderBy/.test(m[1]) && !/\bid\b|\bname\b\s*[:,}]/.test(m[1].split('select')[0]))
        .map(() => f),
    );
    expect(unordered).toEqual([]);
  });
});

describe('registration needs no business name', () => {
  const phone = { idempotencyKey: 'k-12345678', ownerName: 'Aicha', branchName: 'Centre', phone: '+22243210987', password: 'password-1', language: 'fr' };
  const problems = (cls: never, body: object) => validateSync(plainToInstance(cls, body) as object, { forbidNonWhitelisted: true, whitelist: true }).map((e) => e.property);

  it('absent, null or blank: accepted, and blank is null', () => {
    expect(problems(RegisterDto as never, phone)).toEqual([]);
    expect(problems(RegisterDto as never, { ...phone, businessName: null })).toEqual([]);
    const blank = plainToInstance(RegisterDto, { ...phone, businessName: '   ', businessNameAr: '' });
    expect(blank.businessName).toBeNull();
    expect(blank.businessNameAr).toBeNull();
    expect(validateSync(blank).map((e) => e.property)).toEqual([]);
  });

  it('build 3 still sends one: accepted, in whichever script it was typed', () => {
    const old = plainToInstance(RegisterDto, { ...phone, businessName: 'متجر الأمل' });
    expect(validateSync(old)).toEqual([]);
    expect(old.businessName).toBe('متجر الأمل');
  });

  it('the administrator’s form too', () => {
    const body = { idempotencyKey: 'k-12345678', ownerName: 'Aicha', language: 'fr', reason: 'by phone', access: { kind: 'grant', days: 30, reason: 'pilot' } };
    expect(problems(CreateBusinessDto as never, body)).toEqual([]);
  });

  it('a trading name can be cleared', () => {
    const dto = plainToInstance(UpdateNamesDto, { name: '  ' });
    expect(dto.name).toBeNull();
    expect(validateSync(dto)).toEqual([]);
  });
});

describe('a receipt keeps the answer its sale recorded', () => {
  const sale = { businessNameSnapshot: null, businessNameArSnapshot: null, branchNameSnapshot: 'Centre', branchNameArSnapshot: null, sellerNameSnapshot: 'Aicha', sellerNameArSnapshot: null };

  it('no trading name at the sale: none on the receipt, even after one is added later', () => {
    const names = receiptNamesOf({ ...sale, company: { name: 'Added Later', nameAr: null } });
    expect(names.business).toBeNull();
    expect(names.branch?.name).toBe('Centre');
  });

  it('a trading name at the sale: that one, after any rename', () => {
    const names = receiptNamesOf({ ...sale, businessNameSnapshot: 'Old', company: { name: 'New', nameAr: null } });
    expect(names.business?.name).toBe('Old');
  });

  it('a sale from before the snapshots existed still reads the live name', () => {
    const names = receiptNamesOf({ ...sale, branchNameSnapshot: null, company: { name: 'Live', nameAr: null } });
    expect(names.business?.name).toBe('Live');
  });
});
