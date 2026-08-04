import { Injectable } from '@nestjs/common';
import { TrackingType } from '@prisma/client';
import { TrackingStrategy } from './tracking-strategy';
import { ImeiStrategy } from './strategies/imei.strategy';
import { SerialStrategy } from './strategies/serial.strategy';
import { QuantityStrategy } from './strategies/quantity.strategy';

/**
 * The single dispatch point for tracking-type behavior. Callers resolve a
 * strategy by type and never branch on the type themselves. Adding a new
 * tracking type = one new strategy registered here.
 */
@Injectable()
export class TrackingStrategyRegistry {
  private readonly strategies = new Map<TrackingType, TrackingStrategy>();

  constructor() {
    for (const s of [new ImeiStrategy(), new SerialStrategy(), new QuantityStrategy()]) {
      this.strategies.set(s.type, s);
    }
  }

  get(type: TrackingType): TrackingStrategy {
    const strategy = this.strategies.get(type);
    if (!strategy) throw new Error(`No tracking strategy registered for "${type}"`);
    return strategy;
  }

  all(): TrackingStrategy[] {
    return [...this.strategies.values()];
  }
}
