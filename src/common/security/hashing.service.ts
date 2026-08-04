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
}
