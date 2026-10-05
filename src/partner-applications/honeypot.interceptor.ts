import { Injectable } from '@nestjs/common';
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { of } from 'rxjs';
import {
  decoyReference,
  isHoneypotFilled,
} from './partner-application-policy.js';
import { PartnerApplicationsService } from './partner-applications.service.js';

/**
 * Interceptors run before pipes: a filled honeypot gets the normal 202 answer with a well-formed
 * decoy reference before validation, so a bot learns nothing from 400s. Nothing is persisted and
 * the body is never logged. The throttle (a guard) still counts these attempts.
 */
@Injectable()
export class HoneypotInterceptor implements NestInterceptor {
  constructor(private readonly applications: PartnerApplicationsService) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    const http = context.switchToHttp();
    if (!isHoneypotFilled(http.getRequest<Request>().body))
      return next.handle();
    const reference = decoyReference();
    this.applications.logHoneypot(
      reference,
      http.getResponse<Response>().locals.requestId as string,
    );
    return of({ reference, status: 'RECEIVED' as const });
  }
}
