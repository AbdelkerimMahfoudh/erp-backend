import { BadRequestException } from '@nestjs/common';
import { ReceivingFilesService, sniffFileKind } from './receiving-files.service';

/**
 * Uploads are typed by their bytes, not their names (docs/48 control 17).
 */
describe('sniffFileKind', () => {
  it('recognises a workbook by its ZIP signature and a PDF by its header', () => {
    expect(sniffFileKind(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))).toBe('xlsx');
    expect(sniffFileKind(Buffer.from('%PDF-1.7\n%âãÏÓ', 'latin1'))).toBe('pdf');
  });

  it('does not trust anything else', () => {
    expect(sniffFileKind(Buffer.from('<html><script>alert(1)</script>'))).toBe('unknown');
    expect(sniffFileKind(Buffer.from('MZ\x90\x00'))).toBe('unknown');
    expect(sniffFileKind(Buffer.from('PK\x05\x06'))).toBe('unknown'); // an empty ZIP's end-of-directory alone
    expect(sniffFileKind(Buffer.alloc(0))).toBeNull();
  });
});

describe('the upload parser', () => {
  const service = new ReceivingFilesService(null as never);

  it('refuses a file whose bytes contradict its name, before any parser runs', async () => {
    await expect(
      service.parse({ buffer: Buffer.from('%PDF-1.4 renamed'), originalname: 'delivery.xlsx' }),
    ).rejects.toMatchObject({ response: { code: 'file_type_mismatch' } });
    await expect(
      service.parse({ buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), originalname: 'delivery.pdf' }),
    ).rejects.toMatchObject({ response: { code: 'file_type_mismatch' } });
    await expect(
      service.parse({ buffer: Buffer.from('<html>not a workbook</html>'), originalname: 'delivery.xlsx' }),
    ).rejects.toMatchObject({ response: { code: 'file_type_mismatch' } });
  });

  it('refuses a name it does not read at all, whatever the bytes', async () => {
    await expect(
      service.parse({ buffer: Buffer.from('%PDF-1.4'), originalname: 'delivery.exe' }),
    ).rejects.toMatchObject({ response: { code: 'file_type_unsupported' } });
    await expect(service.parse({ buffer: Buffer.alloc(0), originalname: 'delivery.xlsx' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses an oversized file before looking at it', async () => {
    await expect(
      service.parse({ buffer: Buffer.alloc(8 * 1024 * 1024 + 1), originalname: 'delivery.xlsx' }),
    ).rejects.toMatchObject({ response: { code: 'file_too_large' } });
  });
});
