import { BadRequestException } from '@nestjs/common';
import { assertReceipt, detectReceiptType, MAX_RECEIPT_BYTES, receiptKey } from './receipt-rules';

/** A receipt is a picture, decided by its own bytes (0074). */
describe('receipt photos', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
  const heic = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic')]);

  it('recognises what a phone camera saves', () => {
    expect(detectReceiptType(jpeg)?.ext).toBe('jpg');
    expect(detectReceiptType(png)?.ext).toBe('png');
    expect(detectReceiptType(webp)?.ext).toBe('webp');
    expect(detectReceiptType(heic)?.ext).toBe('heic');
  });

  it('refuses anything that is not an image, whatever it is called', () => {
    expect(() => assertReceipt(Buffer.from('%PDF-1.7 not a photo'))).toThrow(BadRequestException);
    expect(() => assertReceipt(Buffer.from('<script>'))).toThrow(BadRequestException);
  });

  it('refuses an empty upload and an oversized one', () => {
    expect(() => assertReceipt(undefined)).toThrow(BadRequestException);
    expect(() => assertReceipt(Buffer.alloc(0))).toThrow(BadRequestException);
    const huge = Buffer.concat([jpeg, Buffer.alloc(MAX_RECEIPT_BYTES)]);
    expect(() => assertReceipt(huge)).toThrow(BadRequestException);
  });

  it('keeps every shop under its own prefix', () => {
    expect(receiptKey('co-1', 'ex-1', 'jpg')).toBe('receipts/co-1/ex-1.jpg');
  });
});
