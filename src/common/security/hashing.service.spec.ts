import { HashingService } from './hashing.service';

describe('HashingService', () => {
  const hashing = new HashingService();

  it('hashes and verifies a value (Argon2id)', async () => {
    const hash = await hashing.hash('s3cret-pass');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await hashing.verify(hash, 's3cret-pass')).toBe(true);
  });

  it('rejects a wrong value and never throws on a bad hash', async () => {
    const hash = await hashing.hash('s3cret-pass');
    expect(await hashing.verify(hash, 'wrong')).toBe(false);
    expect(await hashing.verify('not-a-hash', 'x')).toBe(false);
  });
});
