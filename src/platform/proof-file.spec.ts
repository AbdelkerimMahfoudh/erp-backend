import { contentDisposition, safeProofName, servedProofName, sniffProofType } from './proof-file';

/** 0136 (owner, 2026-11-11): a proof downloads under a usable name, its extension matching what its bytes are. */
describe('a payment proof’s file name and type', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
  const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]);
  const PDF = Buffer.from('%PDF-1.7\n');

  it('the type is what the bytes say — PDF, PNG, JPEG — and nothing else', () => {
    expect(sniffProofType(PNG)).toBe('image/png');
    expect(sniffProofType(JPG)).toBe('image/jpeg');
    expect(sniffProofType(PDF)).toBe('application/pdf');
    expect(sniffProofType(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffProofType(Buffer.alloc(0))).toBeNull();
  });

  it('keeps the sent name, made safe, with the extension of its real type', () => {
    expect(safeProofName('Screenshot 2026-11-11 at 06.43.png', 'image/png')).toBe('Screenshot 2026-11-11 at 06.43.png');
    expect(safeProofName('reçu.jpeg', 'image/jpeg')).toBe('reçu.jpg');
    expect(safeProofName('C:\\Users\\me\\..\\proof.PNG', 'image/png')).toBe('proof.png');
    expect(safeProofName('../../etc/passwd', 'application/pdf')).toBe('passwd.pdf');
    expect(safeProofName('a"b<c>d|e?.png', 'image/png')).toBe('abcde.png');
    expect(safeProofName('invoice.exe', 'application/pdf')).toBe('invoice.pdf');
    expect(safeProofName('إيصال الدفع.png', 'image/png')).toBe('إيصال الدفع.png');
    expect(safeProofName('', 'image/png')).toBeNull();
    expect(safeProofName('.png', 'image/png')).toBeNull();
    expect(safeProofName('x'.repeat(300) + '.png', 'image/png')!.length).toBe(104);
  });

  it('a proof without a kept name — every one before 0136 — is named from its date and type', () => {
    const at = new Date('2026-11-11T06:43:00Z');
    expect(servedProofName({ id: '01a1bd9b-0000-7000-8000-00000045ab12', fileName: null, submittedAt: at }, 'image/png')).toBe('payment-proof-2026-11-11-0045ab12.png');
    expect(servedProofName({ id: 'x-12345678', fileName: 'mine.png', submittedAt: at }, 'image/png')).toBe('mine.png');
    // A kept name that no longer matches the bytes is not used; unknown bytes download as .bin.
    expect(servedProofName({ id: 'x-12345678', fileName: 'mine.png', submittedAt: at }, 'application/pdf')).toBe('payment-proof-2026-11-11-12345678.pdf');
    expect(servedProofName({ id: 'x-12345678', fileName: null, submittedAt: at }, null)).toBe('payment-proof-2026-11-11-12345678.bin');
  });

  it('the header carries an ASCII name and the exact UTF-8 one', () => {
    expect(contentDisposition('proof.png')).toBe(`attachment; filename="proof.png"; filename*=UTF-8''proof.png`);
    const ar = contentDisposition('إيصال.png');
    expect(ar).toMatch(/^attachment; filename="_+\.png"; filename\*=UTF-8''%D8%A5/);
    expect(contentDisposition('a"b.pdf')).toContain('filename="a_b.pdf"');
  });
});
