import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import type { Request } from 'express';
import { UsersService } from '../users/users.service.js';
export const Roles = (...roles: Role[]) => SetMetadata('roles', roles);
export type AuthenticatedRequest = Request & {
  user: NonNullable<Awaited<ReturnType<UsersService['findPublic']>>>;
};
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly users: UsersService,
  ) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const parts = req.headers.authorization?.split(' ');
    if (parts?.length !== 2 || parts[0] !== 'Bearer')
      throw new UnauthorizedException();
    let sub: string;
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; type: string }>(
        parts[1],
        {
          secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
          issuer: 'mandaria',
          audience: 'mandaria-users',
          algorithms: ['HS256'],
        },
      );
      if (payload.type !== 'access' || typeof payload.sub !== 'string')
        throw new Error();
      sub = payload.sub;
    } catch {
      throw new UnauthorizedException();
    }
    const user = await this.users.findPublic(sub);
    if (!user?.active) throw new UnauthorizedException();
    req.user = user;
    return true;
  }
}
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext) {
    const roles = this.reflector.getAllAndOverride<Role[]>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (roles?.length && (!user || !roles.includes(user.role)))
      throw new ForbiddenException();
    return true;
  }
}
