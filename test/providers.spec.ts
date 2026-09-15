import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ProvidersService } from '../dist/providers/providers.service.js';
import { ProviderAccessService } from '../dist/providers/provider-access.service.js';
import type { PrismaService } from '../dist/prisma/prisma.service.js';
import { validateEnvironment } from '../src/config/environment.js';

describe('provider defaults and access', () => {
  it('uses configured defaults by type and respects explicit limits independently', async () => {
    const create = vi
      .fn()
      .mockImplementation(({ data }) => ({ id: 'fixture', ...data }));
    const service = new ProvidersService(
      { deliveryProvider: { create } } as unknown as PrismaService,
      new ConfigService({
        DEFAULT_FLEET_MAX_DRIVERS: 12,
        DEFAULT_FLEET_MAX_VEHICLES: 14,
        DEFAULT_INDEPENDENT_MAX_DRIVERS: 3,
        DEFAULT_INDEPENDENT_MAX_VEHICLES: 4,
      }),
    );
    expect(
      await service.create(
        { name: 'Fleet', code: 'FLEET', type: 'FLEET' },
        'actor',
      ),
    ).toMatchObject({ maxDrivers: 12, maxVehicles: 14 });
    expect(
      await service.create(
        {
          name: 'Independent',
          code: 'INDEPENDENT',
          type: 'INDEPENDENT',
          maxVehicles: 9,
        },
        'actor',
      ),
    ).toMatchObject({ maxDrivers: 3, maxVehicles: 9 });
  });
  it('rejects invalid environment defaults and supplies documented fallback values', () => {
    const input = {
      DATABASE_URL: 'postgresql://localhost/test',
      JWT_ACCESS_SECRET: 'a'.repeat(40),
      JWT_REFRESH_SECRET: 'b'.repeat(40),
      INTEGRATION_JWT_SECRET: 'c'.repeat(40),
    };
    const env = validateEnvironment(input);
    expect([
      env.DEFAULT_FLEET_MAX_DRIVERS,
      env.DEFAULT_FLEET_MAX_VEHICLES,
      env.DEFAULT_INDEPENDENT_MAX_DRIVERS,
      env.DEFAULT_INDEPENDENT_MAX_VEHICLES,
    ]).toEqual([10, 10, 1, 2]);
    for (const value of [0, -1, 1.5, 10001, 'invalid'])
      expect(() =>
        validateEnvironment({ ...input, DEFAULT_FLEET_MAX_DRIVERS: value }),
      ).toThrow('Invalid environment');
  });
  it('does not guess a provider for multiple memberships and uses membership-bound queries', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new ProviderAccessService({
      providerMembership: { findMany },
    } as unknown as PrismaService);
    await expect(service.profile('user-a', 'provider-b')).rejects.toMatchObject(
      { status: 403 },
    );
    expect(findMany.mock.lastCall![0].where).toEqual({
      userId: 'user-a',
      providerId: 'provider-b',
    });
    findMany.mockResolvedValue([{ role: 'ADMIN' }, { role: 'OWNER' }]);
    await expect(service.profile('user-a')).rejects.toMatchObject({
      status: 409,
    });
  });
});
