import { loadSecretFiles } from './secret-files';

/*
 * Imported first by `main.ts`, before the application module: `ConfigModule.forRoot()` validates the environment when
 * that module is imported, so the secrets given as files (`NAME_FILE`) must already be in place by then.
 */
loadSecretFiles(process.env);
