import {
  BadRequestException,
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { AuthenticatedRequest } from '../auth/auth.guards.js';
import { ProviderAccessService } from './provider-access.service.js';

export type ProviderProfile = Awaited<
  ReturnType<ProviderAccessService['profile']>
>;
type ProviderRequest = AuthenticatedRequest & {
  providerProfile: ProviderProfile;
};
@Injectable()
export class ProviderMembershipGuard implements CanActivate {
  constructor(private readonly access: ProviderAccessService) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<ProviderRequest>();
    const id = req.query.providerId;
    // Guards run before ValidationPipe: reject malformed query IDs here too.
    if (id !== undefined && (typeof id !== 'string' || !isUUID(id)))
      throw new BadRequestException('providerId must be a UUID');
    req.providerProfile = await this.access.profile(req.user.id, id);
    return true;
  }
}
export const CurrentProvider = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ProviderProfile =>
    context.switchToHttp().getRequest<ProviderRequest>().providerProfile,
);
