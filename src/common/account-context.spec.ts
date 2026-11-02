import { LoansService } from '../loans/loans.service';
import { ConsignmentsService } from '../consignment/consignments.service';

/**
 * With no trading name, each record names its own store (D227): the one that lent or sent, whichever other stores the
 * same Owner has. Nothing here reads a "first" store.
 */
const ME = Buffer.alloc(16, 1);
const THEM = Buffer.alloc(16, 2);
const PORT = { name: 'Boutique Port', nameAr: 'متجر الميناء' };
const NO_NAME = { name: null, nameAr: null };
const counterparty = { name: 'Hand-typed', kind: 'manual_store', connectedCompany: null };

const loan = (company: object, branch: object | null) => ({
  id: Buffer.alloc(16, 9),
  companyId: THEM,
  counterpartyCompanyId: ME,
  proposedByCompanyId: THEM,
  direction: 'lent',
  status: 'proposed',
  proposedAmount: 100,
  counterAmount: null,
  principal: null,
  createdAt: new Date(),
  version: 0,
  counterparty,
  company,
  branch,
  ledger: [],
});
const summariseLoan = (row: object) => (Object.create(LoansService.prototype) as { summarise(r: object, me: Buffer): { otherParty: string; otherPartyAr: string | null } }).summarise(row, ME);

const consignment = (sourceCompany: object) => ({
  id: Buffer.alloc(16, 9),
  status: 'proposed',
  proposedAmount: null,
  counterAmount: null,
  agreedAmount: null,
  createdAt: new Date(),
  version: 0,
  lines: [],
  counterparty,
  sourceCompany,
  sourceBranch: PORT,
});
const summariseConsignment = (row: object) =>
  (Object.create(ConsignmentsService.prototype) as { summarise(r: object, side: string): { otherParty: string; otherPartyAr: string | null } }).summarise(row, 'destination');

describe('a loan, read by the other side', () => {
  it('names the store that made it', () => {
    expect(summariseLoan(loan(NO_NAME, PORT))).toMatchObject({ otherParty: 'Boutique Port', otherPartyAr: 'متجر الميناء' });
  });

  it('still names the store when a trading name exists, which comes beside it', () => {
    expect(summariseLoan(loan({ name: 'SARL Kiffa', nameAr: null }, PORT))).toMatchObject({ otherParty: 'Boutique Port', otherPartyAr: 'متجر الميناء', otherPartyTradingName: 'SARL Kiffa' });
  });

  it('a loan that recorded no store says nothing rather than guessing one', () => {
    expect(summariseLoan(loan(NO_NAME, null)).otherParty).toBe('');
  });
});

describe('a consignment, read by the destination', () => {
  it('names its source store', () => {
    expect(summariseConsignment(consignment(NO_NAME))).toMatchObject({ otherParty: 'Boutique Port', otherPartyAr: 'متجر الميناء' });
  });
});
