import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { Logger } from 'nestjs-pino';
import { Request, Response } from 'express';
import { AppClsStore } from '../context/request-context';
import { MissingTenantContextError } from '../../prisma/tenant.extension';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  /** Optional machine-readable code (e.g. `device_unrecognized`) for clients to branch on. */
  code?: string;
  requestId?: string;
  path: string;
  timestamp: string;
}

/**
 * Single global exception filter. Produces a consistent error body, maps Prisma
 * and tenant-context errors to appropriate HTTP codes, and NEVER leaks stack
 * traces or SQL to clients. Server-side it logs full detail (5xx as error).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    private readonly logger: Logger,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, message, code } = this.resolve(exception);

    const body: ErrorBody = {
      statusCode: status,
      error: HttpStatus[status] ?? 'ERROR',
      message,
      ...(code ? { code } : {}),
      requestId: this.cls.getId?.() ?? this.cls.get('requestId'),
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    if (status >= 500) {
      this.logger.error({ err: exception, ...body }, 'Unhandled server error');
    } else {
      this.logger.warn({ ...body }, 'Request error');
    }

    response.status(status).json(body);
  }

  private resolve(exception: unknown): { status: number; message: string | string[]; code?: string } {
    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      if (typeof res === 'string') {
        return { status: exception.getStatus(), message: res };
      }
      const obj = res as { message?: string | string[]; code?: string };
      return {
        status: exception.getStatus(),
        message: obj.message ?? exception.message,
        code: typeof obj.code === 'string' ? obj.code : undefined,
      };
    }

    if (exception instanceof MissingTenantContextError) {
      // Internal invariant violation — a tenant query ran without context.
      return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.mapPrismaError(exception);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return { status: HttpStatus.BAD_REQUEST, message: 'Invalid query parameters' };
    }

    return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' };
  }

  private mapPrismaError(e: Prisma.PrismaClientKnownRequestError): {
    status: number;
    message: string;
  } {
    switch (e.code) {
      case 'P2002':
        return { status: HttpStatus.CONFLICT, message: 'A record with these values already exists' };
      case 'P2025':
        return { status: HttpStatus.NOT_FOUND, message: 'Record not found' };
      case 'P2003':
        return { status: HttpStatus.CONFLICT, message: 'Related record constraint failed' };
      case 'P2000':
        return { status: HttpStatus.BAD_REQUEST, message: 'Value too long for column' };
      default:
        return { status: HttpStatus.BAD_REQUEST, message: 'Database request error' };
    }
  }
}
