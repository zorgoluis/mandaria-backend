import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { DomainException } from './domain-error.js';
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);
  catch(exception: unknown, host: ArgumentsHost) {
    if (
      exception instanceof Prisma.PrismaClientKnownRequestError ||
      exception instanceof Prisma.PrismaClientUnknownRequestError
    ) {
      const code =
        /\b(CUSTODY_OPERATION_FORBIDDEN|CUSTODY_INCIDENT_OPEN|EXECUTION_TRANSITION_INVALID|EXECUTION_CONFLICT)\b/.exec(
          exception.message,
        )?.[1];
      if (code) exception = new DomainException(code, 409, code);
    }
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
    const req = ctx.getRequest<Request & { integration?: { id: string } }>();
    const res = ctx.getResponse<Response>();
    const requestId =
      (res.locals.requestId as string | undefined) ?? randomUUID();
    res.setHeader('X-Request-Id', requestId);
    const code = errors.length
      ? 'VALIDATION_ERROR'
      : (domainCode ?? `HTTP_${status}`);
    // Only this known route and allowlisted identifiers are audited. No exception message,
    // SQL, headers, URL/query string or body: any of them may contain credentials or PII.
    const accept =
      req.method === 'POST' &&
      (req.route as { path?: string } | undefined)?.path ===
        '/api/v1/delivery-quotes/:publicId/accept';
    if (accept || status >= 500) {
      const quote = req.params?.publicId;
      const integration = req.integration?.id;
      const event = {
        event: accept ? 'DELIVERY_QUOTE_ACCEPT_FAILED' : 'request_failed',
        status,
        code: /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : `HTTP_${status}`,
        requestId,
        ...(accept && typeof quote === 'string' && /^MQ-\d{6,12}$/i.test(quote)
          ? { quotePublicId: quote.toUpperCase() }
          : {}),
        ...(accept &&
        integration &&
        /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(integration)
          ? { integrationClientId: integration }
          : {}),
      };
      if (status >= 500) this.logger.error(event);
      else this.logger.warn(event);
    }
    ctx
      .getResponse<Response>()
      .status(status)
      .json({
        statusCode: status,
        code,
        requestId,
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
