import { ExpressAdapter } from '@nestjs/platform-express';

/**
 * The HTTP adapter the API is served by: Express, with routes that match their letter case exactly (C13; review
 * finding R5-2).
 *
 * Express matches paths case-insensitively by default, so `POST /API/V1/PLATFORM/MY-SUBSCRIPTION/TRIAL/CLAIM` reached
 * the claim — and a client whose route checks compare text could carry a path no check recognised. With
 * `case sensitive routing` only the canonical lower-case path reaches a handler; any other spelling answers 404.
 *
 * Express reads the setting once, when its router is first built — by the first `use` or route registered, Nest's or
 * `main.ts`'s — so it is set here, on an instance nothing has touched yet, before the adapter is handed to Nest.
 */
export function apiHttpAdapter(): ExpressAdapter {
  const adapter = new ExpressAdapter();
  adapter.set('case sensitive routing', true);
  return adapter;
}
