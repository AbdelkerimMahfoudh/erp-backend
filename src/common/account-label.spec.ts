import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateBusinessDto } from '../platform/platform.controller';
import { RegisterDto } from '../platform/registration.dto';
import { UpdateNamesDto } from '../names/dto/update-names.dto';
import { receiptNamesOf } from '../sales/sales.service';
import { labelArOf, labelOf } from './account-label';

/** An account needs no company name (D227). What people read comes from the store, never from an invented name. */
describe('what an account is called', () => {
  const store = { name: 'Boutique Centre', nameAr: 'متجر المركز' };

  it('its trading name when it has one, and that name alone', () => {
    expect(labelOf({ name: 'SARL Kiffa', nameAr: null, branches: [store] })).toBe('SARL Kiffa');
    expect(labelArOf({ name: 'SARL Kiffa', nameAr: null, branches: [store] })).toBeNull();
  });

  it('otherwise its first store, in both scripts', () => {
    expect(labelOf({ name: null, branches: [store] })).toBe('Boutique Centre');
    expect(labelArOf({ name: null, branches: [store] })).toBe('متجر المركز');
  });

  it('never a placeholder when there is nothing to say', () => {
    expect(labelOf({ name: null, branches: [] })).toBe('');
    expect(labelOf(null)).toBe('');
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
    expect(names.business).toEqual({ name: null, nameAr: null });
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
