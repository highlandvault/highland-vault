import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { ErrorCode, ErrorResponse } from '@hv/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './errors';

const STATUS_CODES: Partial<Record<number, ErrorCode>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

/**
 * Every error leaves the API as { error: { code, message, details? }, requestId }.
 * Unexpected errors are logged with their stack and returned as a generic 500,
 * so internals (SQL, stack traces) never reach clients.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    let status: number;
    let error: ErrorResponse['error'];

    if (exception instanceof AppError) {
      status = exception.status;
      error = { code: exception.code, message: exception.message };
      if (exception.details !== undefined) error.details = exception.details;
      for (const [name, value] of Object.entries(exception.headers ?? {})) {
        void reply.header(name, value);
      }
    } else if (exception instanceof HttpException) {
      // Framework-level errors, e.g. an unknown route (404) or an unparseable body (400).
      status = exception.getStatus();
      error = {
        code: STATUS_CODES[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST'),
        message: status === 404 ? 'Route not found.' : exception.message,
      };
    } else if (isClientError(exception)) {
      // Fastify errors carrying a 4xx status (for example invalid JSON or an oversized body).
      status = exception.statusCode;
      error = { code: STATUS_CODES[status] ?? 'BAD_REQUEST', message: 'The request is malformed.' };
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      error = { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' };
      this.logger.error(
        { err: exception, reqId: request.id },
        exception instanceof Error ? exception.message : 'non-Error thrown',
      );
    }

    const body: ErrorResponse = { error, requestId: String(request.id) };
    void reply.status(status).send(body);
  }
}

function isClientError(value: unknown): value is { statusCode: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'statusCode' in value &&
    typeof value.statusCode === 'number' &&
    value.statusCode >= 400 &&
    value.statusCode < 500
  );
}
