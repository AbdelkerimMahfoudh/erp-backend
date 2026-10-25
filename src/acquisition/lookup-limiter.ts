import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../entitlement/clock';

/**
 * How many wrong guesses a promo code or a link can take (0103, D221).
 *
 * The request throttle already caps every caller at `PUBLIC_THROTTLE` (10 a minute). Wrong answers are rationed
 * further, because a wrong answer is the only thing an enumerator learns from:
 *
 *  - **per address**: {@link PER_ADDRESS_FAILURES} unusable lookups in {@link WINDOW_MS}, then every lookup from that
 *    address is refused until the oldest failure leaves the window — usable codes included, so a locked-out guesser
 *    cannot tell a hit from a miss;
 *  - **for everybody**: {@link GLOBAL_FAILURES} unusable lookups in the window across all addresses, then lookups are
 *    refused for everybody until the window clears. Registration itself never depends on this: a business can always
 *    register without a code.
 *
 * In memory, like the request throttle (one API process). A restart forgets the counts, which the request throttle
 * still bounds.
 */

export const WINDOW_MS = 15 * 60 * 1000;
export const PER_ADDRESS_FAILURES = 5;
export const GLOBAL_FAILURES = 200;

export class TooManyLookupsException extends HttpException {
  constructor() {
    super(
      { code: 'acquisition_lookup_limited', message: 'Too many attempts. Wait a few minutes, or continue without a promo code.' },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

@Injectable()
export class LookupLimiter {
  private readonly byAddress = new Map<string, number[]>();
  private global: number[] = [];

  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  /** Throws while this address, or everybody, has spent its wrong guesses. */
  assertAllowed(address: string | null | undefined): void {
    const now = this.clock.now().getTime();
    this.global = this.recent(this.global, now);
    if (this.global.length >= GLOBAL_FAILURES) throw new TooManyLookupsException();
    const key = address ?? 'unknown';
    const mine = this.recent(this.byAddress.get(key) ?? [], now);
    if (mine.length === 0) this.byAddress.delete(key);
    else this.byAddress.set(key, mine);
    if (mine.length >= PER_ADDRESS_FAILURES) throw new TooManyLookupsException();
  }

  /** One unusable answer, counted against this address and against everybody. */
  recordFailure(address: string | null | undefined): void {
    const now = this.clock.now().getTime();
    const key = address ?? 'unknown';
    this.byAddress.set(key, [...this.recent(this.byAddress.get(key) ?? [], now), now]);
    this.global = [...this.recent(this.global, now), now];
  }

  private recent(times: number[], now: number): number[] {
    return times.filter((t) => now - t < WINDOW_MS);
  }
}
