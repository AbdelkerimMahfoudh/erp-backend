import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AnomaliesController } from './anomalies.controller';
import { REQUIRE_PERMISSIONS_KEY as PERMISSIONS_KEY } from '../rbac/require-permissions.decorator';

/**
 * The routes, as Nest will register them.
 *
 * A decorator attaches to the NEXT method, so a route decorator that drifts
 * above the wrong method re-routes silently: the live render matrix found
 * `POST :key/dismiss` answering with the undo's shape while `:key/undismiss`
 * was 404. Read the metadata rather than the file, so it cannot recur.
 */
describe('anomalies routes', () => {
  const proto = AnomaliesController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const route = (name: string) => ({
    path: Reflect.getMetadata(PATH_METADATA, proto[name]) as string | undefined,
    method: Reflect.getMetadata(METHOD_METADATA, proto[name]) as RequestMethod | undefined,
    permissions: Reflect.getMetadata(PERMISSIONS_KEY, proto[name]) as string[] | undefined,
  });

  it('lists on GET /, dismisses on POST :key/dismiss, undoes on POST :key/undismiss', () => {
    expect(route('list')).toMatchObject({ path: '/', method: RequestMethod.GET, permissions: ['report.view'] });
    expect(route('dismiss')).toMatchObject({ path: ':key/dismiss', method: RequestMethod.POST, permissions: ['report.view'] });
    expect(route('undismiss')).toMatchObject({ path: ':key/undismiss', method: RequestMethod.POST, permissions: ['report.view'] });
  });

  it('has exactly these three handlers', () => {
    const handlers = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && Reflect.hasMetadata(PATH_METADATA, proto[n]));
    expect(handlers.sort()).toEqual(['dismiss', 'list', 'undismiss']);
  });
});
