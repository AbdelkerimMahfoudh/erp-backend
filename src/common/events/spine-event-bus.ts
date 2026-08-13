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

/**
 * Emitted immediately AFTER stock physically moves between two branches — a
 * shipment or a receipt.
 *
 * It exists because valuation was only ever refreshed by a sale. A transfer
 * changes what both branches hold and triggered nothing, so `inventory_valuation`
 * stayed as it was until the next sale happened to touch that branch. The
 * figure was quietly stale from the moment H1.3 shipped serialized transfers,
 * and H1.4's in-transit total made it visible: held value had not fallen, so
 * held + in-transit briefly counted the same goods twice.
 *
 * Carries both ends, because both changed.
 */
export interface StockMovedEvent {
  companyId: Buffer;
  fromBranchId: Buffer;
  toBranchId: Buffer;
  transferId: Buffer;
  phase: 'shipped' | 'received';
}

export type SpineEventMap = {
  'sale.recorded': SaleRecordedEvent;
  'stock.moved': StockMovedEvent;
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
