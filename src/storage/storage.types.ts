/**
 * Storage abstraction. The app depends on {@link StorageProvider}; the concrete
 * implementation (local disk now, S3 later) is swappable behind {@link STORAGE_PROVIDER}.
 * Feature modules use this for product photos, scanned IMEI images, receipts, and
 * report/CSV exports.
 */
export interface StoredObject {
  key: string;
  size: number;
  contentType?: string;
}

export interface StorageProvider {
  put(key: string, data: Buffer, contentType?: string): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export const STORAGE_PROVIDER = 'STORAGE_PROVIDER';
