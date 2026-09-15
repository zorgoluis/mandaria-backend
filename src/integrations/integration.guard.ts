import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { IntegrationAuthService } from './integration-auth.service.js';
export type IntegrationRequest = Request & {
  integration: Awaited<ReturnType<IntegrationAuthService['authenticate']>>;
};
@Injectable()
export class IntegrationGuard implements CanActivate {
  constructor(private readonly auth: IntegrationAuthService) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<IntegrationRequest>();
    const parts = req.headers.authorization?.split(' ');
    if (parts?.length !== 2 || parts[0] !== 'Bearer' || parts[1].length > 8192)
      throw new UnauthorizedException('Invalid integration credentials');
    req.integration = await this.auth.authenticate(parts[1]);
    return true;
  }
}
