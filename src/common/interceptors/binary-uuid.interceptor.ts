import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { binToUuid, isBinaryId } from '../utils/uuid.util';

/**
 * Serialization boundary for responses:
 *  - BINARY(16) ids (`Buffer`) → canonical UUID strings (API never emits binary);
 *  - Prisma `Decimal` (money) → JSON number;
 *  - `BigInt` → string (JSON cannot serialize BigInt).
 * Walks plain objects/arrays; leaves Dates and non-16-byte Buffers intact.
 */
@Injectable()
export class BinaryUuidInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => this.transform(data, new WeakSet())));
  }

  private transform(value: unknown, seen: WeakSet<object>): unknown {
    if (isBinaryId(value)) {
      return binToUuid(value);
    }
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (value instanceof Prisma.Decimal) {
      return value.toNumber();
    }
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (value instanceof Date || Buffer.isBuffer(value)) {
      return value;
    }
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => this.transform(item, seen));
    }

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = this.transform(val, seen);
    }
    return out;
  }
}
