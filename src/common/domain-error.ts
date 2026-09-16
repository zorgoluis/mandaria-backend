import { HttpException } from '@nestjs/common';

/**
 * HTTP error with a stable machine-readable code (e.g. OUT_OF_SERVICE_AREA). The global
 * HttpErrorFilter exposes `code`; messages of 5xx statuses stay sanitized.
 */
export class DomainException extends HttpException {
  constructor(
    readonly code: string,
    status: number,
    message: string,
  ) {
    super({ code, message }, status);
  }
}
