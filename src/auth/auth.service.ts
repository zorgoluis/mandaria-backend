import {
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';
import { hashSecret, matchesSecret, newSecret } from '../common/security.js';

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private dummyHash!: string;
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}
  async onModuleInit() {
    this.dummyHash = await argon2.hash(newSecret(), { type: argon2.argon2id });
  }
  async login(email: string, password: string) {
    const user = await this.users.findByEmail(email);
    const valid = await argon2.verify(
      user?.passwordHash ?? this.dummyHash,
      password,
    );
    if (!user?.active || !valid) {
      this.logger.warn({ event: 'login_rejected' });
      throw new UnauthorizedException('Invalid credentials');
    }
    const tokens = await this.issue(user.id);
    await this.prisma.refreshToken.create({ data: tokens.record });
    this.logger.log({ event: 'login_succeeded', userId: user.id });
    return tokens.response;
  }
  private async issue(userId: string) {
    const id = randomUUID();
    const accessSeconds = this.config.getOrThrow<number>(
      'JWT_ACCESS_EXPIRES_IN',
    );
    const refreshSeconds = this.config.getOrThrow<number>(
      'JWT_REFRESH_EXPIRES_IN',
    );
    const accessToken = await this.jwt.signAsync(
      { sub: userId, type: 'access' },
      {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: accessSeconds,
        issuer: 'mandaria',
        audience: 'mandaria-users',
        algorithm: 'HS256',
      },
    );
    const refreshToken = await this.jwt.signAsync(
      { sub: userId, jti: id, type: 'refresh' },
      {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: refreshSeconds,
        issuer: 'mandaria',
        audience: 'mandaria-refresh',
        algorithm: 'HS256',
      },
    );
    return {
      record: {
        id,
        userId,
        tokenHash: hashSecret(refreshToken),
        expiresAt: new Date(Date.now() + refreshSeconds * 1000),
      },
      response: {
        accessToken,
        refreshToken,
        tokenType: 'Bearer',
        expiresIn: accessSeconds,
      },
    };
  }
  private async verifyRefresh(token: string) {
    try {
      const payload = await this.jwt.verifyAsync<{
        sub: string;
        jti: string;
        type: string;
      }>(token, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        issuer: 'mandaria',
        audience: 'mandaria-refresh',
        algorithms: ['HS256'],
      });
      if (
        payload.type !== 'refresh' ||
        typeof payload.sub !== 'string' ||
        typeof payload.jti !== 'string'
      )
        throw new Error();
      return payload;
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }
  async refresh(token: string) {
    const payload = await this.verifyRefresh(token);
    const next = await this.issue(payload.sub);
    await this.prisma.$transaction(async (tx) => {
      const record = await tx.refreshToken.findUnique({
        where: { id: payload.jti },
        include: { user: true },
      });
      if (
        !record ||
        record.userId !== payload.sub ||
        !record.user.active ||
        record.revokedAt ||
        record.expiresAt <= new Date() ||
        !matchesSecret(token, record.tokenHash)
      )
        throw new UnauthorizedException('Invalid refresh token');
      const consumed = await tx.refreshToken.updateMany({
        where: {
          id: record.id,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { revokedAt: new Date() },
      });
      if (consumed.count !== 1)
        throw new UnauthorizedException('Invalid refresh token');
      await tx.refreshToken.create({ data: next.record });
    });
    this.logger.log({ event: 'refresh_rotated', userId: payload.sub });
    return next.response;
  }
  async logout(token: string) {
    const payload = await this.verifyRefresh(token);
    await this.prisma.refreshToken.updateMany({
      where: {
        id: payload.jti,
        userId: payload.sub,
        tokenHash: hashSecret(token),
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    this.logger.log({ event: 'logout', userId: payload.sub });
  }
}
