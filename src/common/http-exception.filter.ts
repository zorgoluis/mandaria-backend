import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const parserStatus =
      typeof exception === 'object' &&
      exception &&
      'type' in exception &&
      'status' in exception &&
      ['entity.too.large', 'entity.parse.failed'].includes(
        String(exception.type),
      )
        ? Number(exception.status)
        : 500;
    const status =
      exception instanceof HttpException ? exception.getStatus() : parserStatus;
    const body =
      exception instanceof HttpException ? exception.getResponse() : null;
    const message =
      typeof body === 'object' && body && 'message' in body
        ? body.message
        : undefined;
    const errors = status === 400 && Array.isArray(message) ? message : [];
    // Domain errors (DomainException) carry a stable code such as OUT_OF_SERVICE_AREA.
    const domainCode =
      typeof body === 'object' &&
      body &&
      'code' in body &&
      typeof body.code === 'string'
        ? body.code
        : undefined;
    if (status >= 500) this.logger.error({ event: 'request_failed', status });
    ctx
      .getResponse<Response>()
      .status(status)
      .json({
        statusCode: status,
        code: errors.length
          ? 'VALIDATION_ERROR'
          : (domainCode ?? `HTTP_${status}`),
        message:
          status >= 500
            ? 'Service unavailable'
            : errors.length
              ? 'Validation failed'
              : typeof message === 'string'
                ? message
                : 'Request failed',
        errors,
        timestamp: new Date().toISOString(),
        path: ctx.getRequest<Request>().path,
      });
  }
}
