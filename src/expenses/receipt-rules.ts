import { BadRequestException } from '@nestjs/common';

/**
 * A receipt photo attached to an expense (0074).
 *
 * Optional, and only ever a picture of a piece of paper. The type is decided by
 * the file's own first bytes — never by its name or the content type a phone
 * claims — so nothing that is not an image is stored under a receipt's name.
 */

/** A phone photo of a till slip is well under this; a document scan might not be. */
export const MAX_RECEIPT_BYTES = 6 * 1024 * 1024;

export type ReceiptType = { ext: 'jpg' | 'png' | 'webp' | 'heic'; contentType: string };

export function detectReceiptType(bytes: Buffer): ReceiptType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: 'jpg', contentType: 'image/jpeg' };
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: 'png', contentType: 'image/png' };
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return { ext: 'webp', contentType: 'image/webp' };
  }
  // HEIC/HEIF: an ISO box `ftyp` at offset 4 with a HEIF brand — what an iPhone
  // camera saves by default.
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 12);
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1', 'heif'].includes(brand)) {
      return { ext: 'heic', contentType: 'image/heic' };
    }
  }
  return null;
}

export function assertReceipt(bytes: Buffer | undefined): ReceiptType {
  if (!bytes || bytes.length === 0) {
    throw new BadRequestException({ code: 'receipt_missing', message: 'Choose a photo of the receipt' });
  }
  if (bytes.length > MAX_RECEIPT_BYTES) {
    throw new BadRequestException({ code: 'receipt_too_large', message: 'That photo is too large' });
  }
  const type = detectReceiptType(bytes);
  if (!type) {
    throw new BadRequestException({ code: 'receipt_not_image', message: 'A receipt must be a photo (JPEG, PNG, WebP or HEIC)' });
  }
  return type;
}

/** Where a receipt lives. Company first, so no key can ever reach another shop's. */
export function receiptKey(companyHex: string, expenseHex: string, ext: ReceiptType['ext']): string {
  return `receipts/${companyHex}/${expenseHex}.${ext}`;
}
