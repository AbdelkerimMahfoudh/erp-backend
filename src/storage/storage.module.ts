import { Global, Module } from '@nestjs/common';
import { LocalDiskStorage } from './local-disk.storage';
import { STORAGE_PROVIDER } from './storage.types';

/**
 * Global storage module. Binds {@link STORAGE_PROVIDER} to the local-disk
 * implementation for now; swap the `useClass` for an S3 provider in production.
 * Feature modules inject `@Inject(STORAGE_PROVIDER) provider: StorageProvider`.
 */
@Global()
@Module({
  providers: [{ provide: STORAGE_PROVIDER, useClass: LocalDiskStorage }],
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
