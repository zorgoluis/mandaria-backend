import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { IntegrationClient } from '@prisma/client';
import type { Request } from 'express';
import { IntegrationsService } from './integrations.service.js';
export type IntegrationRequest = Request & { integration: IntegrationClient };
@Injectable()
export class IntegrationGuard implements CanActivate {
  constructor(private readonly integrations: IntegrationsService) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<IntegrationRequest>();
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string') throw new UnauthorizedException();
    req.integration = await this.integrations.authenticate(key);
    return true;
  }
}
