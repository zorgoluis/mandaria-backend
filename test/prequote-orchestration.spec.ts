import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { validateEnvironment } from '../src/config/environment.js';
import { prequoteEffectiveStatus } from '../src/delivery-prequotes/prequote-conditions.js';
import { UnavailablePrequoteConsumption } from '../src/delivery-prequotes/prequote-consumption.js';
const valid = {
  DATABASE_URL: 'postgresql://localhost/mandaria',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  INTEGRATION_JWT_SECRET: 'c'.repeat(40),
};
describe('A4 execution configuration', () => {
  it('defaults to disabled, independent 15 minute TTL and bounded leases/retries', () => {
    expect(validateEnvironment(valid)).toMatchObject({
      PREQUOTE_ENABLED: false,
      PREQUOTE_VALIDITY_MS: 900000,
      PREQUOTE_LEASE_MS: 90000,
      PREQUOTE_MAX_ATTEMPTS: 3,
    });
  });
  it.each([
    { PREQUOTE_VALIDITY_MS: 0 },
    { PREQUOTE_VALIDITY_MS: 86400001 },
    { PREQUOTE_LEASE_MS: 300001 },
    { PREQUOTE_MAX_ATTEMPTS: 6 },
    { PREQUOTE_MAX_ATTEMPTS: 0 },
    { PREQUOTE_ENABLED: '1' },
  ])('rejects invalid config %j', (overrides) => {
    expect(() => validateEnvironment({ ...valid, ...overrides })).toThrow();
  });
  it('requires complete routing retries/backoff plus publication margin even when disabled', () => {
    expect(() =>
      validateEnvironment({
        ...valid,
        GOOGLE_ROUTES_TIMEOUT_MS: 15000,
        GOOGLE_ROUTES_MAX_RETRIES: 2,
        PREQUOTE_LEASE_MS: 60599,
      }),
    ).toThrow('publication margin');
    expect(
      validateEnvironment({
        ...valid,
        GOOGLE_ROUTES_TIMEOUT_MS: 15000,
        GOOGLE_ROUTES_MAX_RETRIES: 2,
        PREQUOTE_LEASE_MS: 60600,
      }).PREQUOTE_LEASE_MS,
    ).toBe(60600);
  });
  it('production permission always denies independently of flags and environment', async () => {
    expect(await new UnavailablePrequoteConsumption().admit()).toEqual({
      admitted: false,
    });
  });
  it('expiration boundary is exclusive and deterministic', () => {
    const expiresAt = new Date(1000);
    expect(prequoteEffectiveStatus({ expiresAt }, new Date(999))).toBe(
      'OFFERED',
    );
    expect(prequoteEffectiveStatus({ expiresAt }, expiresAt)).toBe('EXPIRED');
  });
});
