import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

/**
 * Emitted immediately AFTER a sale's DB transaction commits. Carries enough to
 * drive derived side effects (rollups, daily-closing, external notifications)
 * without coupling them to the sale transaction — a side-effect failure must
 * never roll back a committed sale.
 */
export interface SaleRecordedEvent {
  saleId: Buffer;
  companyId: Buffer;
  branchId: Buffer;
  day: string; // YYYY-MM-DD (branch-day for rollups)
  total: number;
  margin: number;
}

export type SpineEventMap = {
  'sale.recorded': SaleRecordedEvent;
};

/**
 * Thin, typed in-process event bus for spine side effects. Listeners are
 * registered by the analytics/closing modules in Sub-phase 2D. In production
 * this can be backed by the BullMQ RollupQueue (P1) without changing emitters.
 */
@Injectable()
export class SpineEventBus {
  private readonly emitter = new EventEmitter();

  emit<K extends keyof SpineEventMap>(event: K, payload: SpineEventMap[K]): void {
    this.emitter.emit(event, payload);
  }

  on<K extends keyof SpineEventMap>(event: K, handler: (payload: SpineEventMap[K]) => void): void {
    this.emitter.on(event, handler);
  }
}
