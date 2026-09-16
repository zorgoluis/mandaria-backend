import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { IntegrationAuthService } from '../dist/integrations/integration-auth.service.js';
import { IntegrationScopesGuard } from '../dist/integrations/integration-scopes.js';
import { hashSecret } from '../dist/common/security.js';
import type { PrismaService } from '../dist/prisma/prisma.service.js';

describe('B2B JWT validation', () => {
  it('rejects expired and malformed claims and intersects current scopes', async () => {
    const config = new ConfigService({
      INTEGRATION_JWT_SECRET: randomBytes(48).toString('hex'),
    });
    const jwt = new JwtService();
    const integrationId = randomUUID();
    const credentialId = randomUUID();
    const findUnique = vi
      .fn()
      .mockResolvedValue({
        clientId: integrationId,
        status: 'ACTIVE',
        revokedAt: null,
        scopes: ['deliveries:read'],
        client: { id: integrationId, status: 'ACTIVE' },
      });
    const service = new IntegrationAuthService(
      { integrationCredential: { findUnique } } as unknown as PrismaService,
      jwt,
      config,
    );
    const payload = {
      sub: integrationId,
      credentialId,
      scopes: ['deliveries:read', 'quotes:create'],
      principalType: 'integration',
      type: 'integration_access',
    };
    const options = {
      secret: config.getOrThrow<string>('INTEGRATION_JWT_SECRET'),
      issuer: 'mandaria',
      audience: 'mandaria-integrations',
      algorithm: 'HS256' as const,
    };
    await expect(
      service.authenticate(
        await jwt.signAsync(payload, { ...options, expiresIn: -1 }),
      ),
    ).rejects.toThrow();
    await expect(
      service.authenticate(
        await jwt.signAsync(
          { ...payload, principalType: 'user' },
          { ...options, expiresIn: 60 },
        ),
      ),
    ).rejects.toThrow();
    await expect(
      service.authenticate(await jwt.signAsync(payload, options)),
    ).rejects.toThrow();
    const result = await service.authenticate(
      await jwt.signAsync(payload, { ...options, expiresIn: 60 }),
    );
    expect(result.scopes).toEqual(['deliveries:read']);
    findUnique.mockResolvedValue({
      clientId: randomUUID(),
      status: 'ACTIVE',
      client: { status: 'ACTIVE' },
    });
    await expect(
      service.authenticate(
        await jwt.signAsync(payload, { ...options, expiresIn: 60 }),
      ),
    ).rejects.toThrow();
  });
  it('caps token duration at credential expiry and never returns the secret hash', async () => {
    const secret = randomBytes(32).toString('base64url');
    const config = new ConfigService({
      INTEGRATION_JWT_SECRET: randomBytes(48).toString('hex'),
      INTEGRATION_ACCESS_TOKEN_EXPIRES_IN: 3600,
    });
    const prisma = {
      integrationCredential: {
        findUnique: vi
          .fn()
          .mockResolvedValue({
            id: randomUUID(),
            clientId: randomUUID(),
            secretHash: hashSecret(secret),
            status: 'ACTIVE',
            revokedAt: null,
            expiresAt: new Date(Date.now() + 30000),
            scopes: [],
            client: { status: 'ACTIVE' },
          }),
        update: vi.fn(),
      },
    };
    const service = new IntegrationAuthService(
      prisma as unknown as PrismaService,
      new JwtService(),
      config,
    );
    const response = await service.token(randomUUID(), secret);
    expect(response.expiresIn).toBeLessThanOrEqual(30);
    expect(JSON.stringify(response).includes(secret)).toBe(false);
    expect(Object.keys(response).sort()).toEqual([
      'accessToken',
      'expiresIn',
      'tokenType',
    ]);
  });
});

describe('IntegrationScopesGuard', () => {
  it('requires every scope and an authenticated integration principal', () => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([
      'deliveries:read',
      'quotes:create',
    ]);
    const guard = new IntegrationScopesGuard(reflector);
    const context = (integration?: { scopes: string[] }) =>
      ({
        getHandler: () => () => {},
        getClass: () => class {},
        switchToHttp: () => ({ getRequest: () => ({ integration }) }),
      }) as unknown as ExecutionContext;
    expect(() => guard.canActivate(context())).toThrow();
    expect(() =>
      guard.canActivate(context({ scopes: ['deliveries:read'] })),
    ).toThrow();
    expect(
      guard.canActivate(
        context({ scopes: ['deliveries:read', 'quotes:create'] }),
      ),
    ).toBe(true);
  });
});
