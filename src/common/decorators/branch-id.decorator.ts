import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { isUuid } from '../utils/uuid.util';

/**
 * Injects the current branch id (canonical UUID string) from the `X-Branch-Id`
 * request header, or `undefined` if absent/invalid. Convert to Buffer with
 * `uuidToBin` when querying.
 */
export const BranchId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const header = ctx.switchToHttp().getRequest<Request>().headers['x-branch-id'];
    return typeof header === 'string' && isUuid(header) ? header : undefined;
  },
);
