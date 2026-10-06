import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  applyDecorators,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import type { Request } from 'express';
import { UsersService } from '../users/users.service.js';
import { ApiExtension } from '@nestjs/swagger';
export const Roles = (...roles: Role[]) =>
  applyDecorators(SetMetadata('roles', roles), ApiExtension('x-roles', roles));
export type AuthenticatedRequest = Request & {
  user: NonNullable<Awaited<ReturnType<UsersService['findPublic']>>>;
  authentication: { sessionVersion: number; tokenExpiresAt: Date };
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
    let version: number;
    let expiresAt: Date;
    try {
      const payload = await this.jwt.verifyAsync<{
        sub: string;
        type: string;
        sv?: number;
        exp: number;
      }>(parts[1], {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        issuer: 'mandaria',
        audience: 'mandaria-users',
        algorithms: ['HS256'],
      });
      if (payload.type !== 'access' || typeof payload.sub !== 'string')
        throw new Error();
      sub = payload.sub;
      version = payload.sv ?? 0;
      if (!Number.isInteger(version) || version < 0) throw new Error();
      if (!Number.isInteger(payload.exp)) throw new Error();
      expiresAt = new Date(payload.exp * 1000);
    } catch {
      throw new UnauthorizedException();
    }
    const user = await this.users.findPublic(sub);
    if (!user?.active || !(await this.users.sessionValid(sub, version)))
      throw new UnauthorizedException();
    req.user = user;
    req.authentication = { sessionVersion: version, tokenExpiresAt: expiresAt };
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
