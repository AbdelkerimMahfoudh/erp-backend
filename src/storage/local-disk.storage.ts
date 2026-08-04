import { Injectable } from '@nestjs/common';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AppConfigService } from '../common/config/app-config.service';
import { StorageProvider, StoredObject } from './storage.types';

/**
 * Local-disk implementation of {@link StorageProvider} for development. Keys are
 * treated as relative paths under `UPLOAD_DIR`; path traversal is stripped.
 * Production swaps this for an S3-backed provider without touching callers.
 */
@Injectable()
export class LocalDiskStorage implements StorageProvider {
  private readonly root: string;

  constructor(config: AppConfigService) {
    this.root = resolve(config.uploadDir);
  }

  private full(key: string): string {
    const safe = key.replace(/^([/\\])+/, '').replace(/\.\.[/\\]/g, '');
    return join(this.root, safe);
  }

  async put(key: string, data: Buffer, contentType?: string): Promise<StoredObject> {
    const path = this.full(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    return { key, size: data.length, contentType };
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.full(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.full(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.full(key));
      return true;
    } catch {
      return false;
    }
  }
}
