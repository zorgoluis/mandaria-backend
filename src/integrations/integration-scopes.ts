import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IntegrationRequest } from './integration.guard.js';

export const INTEGRATION_SCOPES = [
  'quotes:create',
  'deliveries:create',
  'deliveries:read',
  'deliveries:cancel',
] as const;
export type IntegrationScope = (typeof INTEGRATION_SCOPES)[number];
const SCOPES_METADATA = 'integration:scopes';
export const IntegrationScopes = (...scopes: IntegrationScope[]) =>
  SetMetadata(SCOPES_METADATA, scopes);

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
