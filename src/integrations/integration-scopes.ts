import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiExtension } from '@nestjs/swagger';
import type { IntegrationRequest } from './integration.guard.js';

export const INTEGRATION_SCOPES = [
  'quotes:create',
  'quotes:read',
  'quotes:accept',
  'deliveries:create',
  'deliveries:read',
  'deliveries:cancel',
] as const;
export type IntegrationScope = (typeof INTEGRATION_SCOPES)[number];
const SCOPES_METADATA = 'integration:scopes';
export const IntegrationScopes = (...scopes: IntegrationScope[]) =>
  applyDecorators(
    SetMetadata(SCOPES_METADATA, scopes),
    ApiExtension('x-scopes', scopes),
  );

@Injectable()
export class IntegrationScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext) {
    const required =
      this.reflector.getAllAndOverride<IntegrationScope[]>(SCOPES_METADATA, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    const principal = context
      .switchToHttp()
      .getRequest<IntegrationRequest>().integration;
    if (
      !principal ||
      !required.every((scope) => principal.scopes.includes(scope))
    )
      throw new ForbiddenException('Insufficient integration scopes');
    return true;
  }
}
