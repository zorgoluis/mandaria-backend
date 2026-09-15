import 'reflect-metadata';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { Logger, type ExecutionContext } from '@nestjs/common';
import { randomUUID, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { AuthService } from '../dist/auth/auth.service.js';
import { AccessGuard, RolesGuard } from '../dist/auth/auth.guards.js';
import { HealthController } from '../dist/health/health.controller.js';
import { IntegrationsService } from '../dist/integrations/integrations.service.js';
import { hashSecret } from '../dist/common/security.js';
import type { PrismaService } from '../dist/prisma/prisma.service.js';
import type { UsersService } from '../dist/users/users.service.js';

const jwt = new JwtService();
const config = new ConfigService({
  JWT_ACCESS_SECRET: randomBytes(48).toString('hex'),
  JWT_REFRESH_SECRET: randomBytes(48).toString('hex'),
  JWT_ACCESS_EXPIRES_IN: 900,
  JWT_REFRESH_EXPIRES_IN: 604800,
});
const user = {
  id: randomUUID(),
  email: 'unit@example.test',
  passwordHash: '',
  active: true,
  role: 'SUPER_ADMIN',
};
const password = randomBytes(20).toString('hex');
const users = { findByEmail: vi.fn(), findPublic: vi.fn() };
const refresh = { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() };
const prisma = {
  refreshToken: refresh,
  $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({ refreshToken: refresh }),
  ),
};
const auth = new AuthService(
  prisma as unknown as PrismaService,
  users as unknown as UsersService,
  jwt,
  config,
);
beforeAll(async () => {
  Logger.overrideLogger(false);
  user.passwordHash = await argon2.hash(password);
  await auth.onModuleInit();
});
describe('authentication services', () => {
  it('accepts correct password and persists only refresh hash', async () => {
    users.findByEmail.mockResolvedValue(user);
    const tokens = await auth.login(user.email, password);
    const record = refresh.create.mock.lastCall![0].data;
    expect(record.tokenHash).toBe(hashSecret(tokens.refreshToken));
    expect(record.tokenHash).not.toBe(tokens.refreshToken);
    expect(jwt.decode(tokens.accessToken).type).toBe('access');
  });
  it('rejects wrong password and unknown user', async () => {
    users.findByEmail.mockResolvedValue(user);
    await expect(auth.login(user.email, 'wrong')).rejects.toThrow(
      'Invalid credentials',
    );
    users.findByEmail.mockResolvedValue(null);
    await expect(auth.login(user.email, password)).rejects.toThrow(
      'Invalid credentials',
    );
  });
  it('rotates and rejects revoked or concurrently consumed refresh', async () => {
    users.findByEmail.mockResolvedValue(user);
    const tokens = await auth.login(user.email, password);
    const record = {
      ...refresh.create.mock.lastCall![0].data,
      user,
      revokedAt: null,
    };
    refresh.findUnique.mockResolvedValue(record);
    refresh.updateMany.mockResolvedValue({ count: 1 });
    const next = await auth.refresh(tokens.refreshToken);
    expect(next.refreshToken).not.toBe(tokens.refreshToken);
    refresh.updateMany.mockResolvedValue({ count: 0 });
    await expect(auth.refresh(tokens.refreshToken)).rejects.toThrow(
      'Invalid refresh token',
    );
    refresh.findUnique.mockResolvedValue({ ...record, revokedAt: new Date() });
    await expect(auth.refresh(tokens.refreshToken)).rejects.toThrow(
      'Invalid refresh token',
    );
    await expect(auth.refresh(tokens.accessToken)).rejects.toThrow(
      'Invalid refresh token',
    );
  });
  it('revokes the corresponding refresh on logout', async () => {
    users.findByEmail.mockResolvedValue(user);
    const tokens = await auth.login(user.email, password);
    await auth.logout(tokens.refreshToken);
    expect(refresh.updateMany.mock.lastCall![0].where.tokenHash).toBe(
      hashSecret(tokens.refreshToken),
    );
    expect(refresh.updateMany.mock.lastCall![0].data.revokedAt).toBeInstanceOf(
      Date,
    );
  });
});

function context(req: unknown) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getClass: () => class {},
    getHandler: () => () => undefined,
  } as unknown as ExecutionContext;
}
describe('guards and health', () => {
  it('checks access tokens and rejects disabled users', async () => {
    users.findByEmail.mockResolvedValue(user);
    users.findPublic.mockResolvedValue(user);
    const tokens = await auth.login(user.email, password);
    const guard = new AccessGuard(
      jwt,
      config,
      users as unknown as UsersService,
    );
    await expect(guard.canActivate(context({ headers: {} }))).rejects.toThrow();
    await expect(
      guard.canActivate(
        context({ headers: { authorization: `Bearer ${tokens.accessToken}` } }),
      ),
    ).resolves.toBe(true);
    users.findPublic.mockResolvedValue({ ...user, active: false });
    await expect(
      guard.canActivate(
        context({ headers: { authorization: `Bearer ${tokens.accessToken}` } }),
      ),
    ).rejects.toThrow();
  });
  it('denies roles outside the declared permissions', () => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['SUPER_ADMIN']);
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(context({ user }))).toBe(true);
    expect(() =>
      guard.canActivate(context({ user: { role: 'DRIVER' } })),
    ).toThrow();
  });
  it('health queries the database and maps failures to 503', async () => {
    const query = vi.fn().mockResolvedValue([{ '?column?': 1 }]);
    const health = new HealthController({
      $queryRaw: query,
    } as unknown as PrismaService);
    await expect(health.check()).resolves.toEqual({
      status: 'ok',
      database: 'up',
    });
    query.mockRejectedValue(new Error('database details'));
    await expect(health.check()).rejects.toMatchObject({ status: 503 });
  });
});

describe('integration authentication', () => {
  it('validates hashed credentials and rejects revocation, disabled clients and bad secrets', async () => {
    const id = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const record = {
      secretHash: hashSecret(secret),
      revokedAt: null,
      client: { id: randomUUID(), status: 'ACTIVE' },
    };
    const findUnique = vi.fn().mockResolvedValue(record);
    const service = new IntegrationsService({
      integrationCredential: { findUnique },
    } as unknown as PrismaService);
    await expect(service.authenticate(`${id}.${secret}`)).resolves.toEqual(
      record.client,
    );
    await expect(
      service.authenticate(`${id}.${randomBytes(32).toString('base64url')}`),
    ).rejects.toThrow();
    findUnique.mockResolvedValue({ ...record, revokedAt: new Date() });
    await expect(service.authenticate(`${id}.${secret}`)).rejects.toThrow();
    findUnique.mockResolvedValue({
      ...record,
      client: { ...record.client, status: 'INACTIVE' },
    });
    await expect(service.authenticate(`${id}.${secret}`)).rejects.toThrow();
  });
});
