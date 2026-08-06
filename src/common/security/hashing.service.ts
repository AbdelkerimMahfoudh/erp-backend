import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/** Centralized Argon2id hashing for passwords, PINs, and refresh secrets. */
@Injectable()
export class HashingService {
  hash(plain: string): Promise<string> {
    return argon2.hash(plain, { type: argon2.argon2id });
  }

  /** Constant-time verify; returns false on any error (never throws). */
  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }

  private dummyHash?: string;

  /**
   * Always-false verify against a throwaway hash, so a login for a missing
   * company or user still spends an Argon2 verify. Without it, "no such Store ID
   * / user" would return measurably faster than "wrong password", letting timing
   * distinguish the two — the enumeration the login is designed to prevent.
   */
  async verifyDummy(plain: string): Promise<false> {
    if (!this.dummyHash) {
      this.dummyHash = await this.hash('argon2id-timing-equalizer');
    }
    await this.verify(this.dummyHash, plain);
    return false;
  }
}
