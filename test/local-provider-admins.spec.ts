import { describe, expect, it } from 'vitest';
import { assertLocalSeedAllowed } from '../scripts/local-provider-admins.js';

const valid = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://mandaria:pw@localhost:5432/mandaria_db',
  LOCAL_PROVIDER_ADMIN_PASSWORD: 'a'.repeat(32),
  BOOTSTRAP_ADMIN_PASSWORD: 'b'.repeat(32),
};

describe('local PROVIDER_ADMIN seed protections', () => {
  it('allows development/test against a local database', () => {
    expect(assertLocalSeedAllowed(valid)).toBe('a'.repeat(32));
    expect(assertLocalSeedAllowed({ ...valid, NODE_ENV: 'test' })).toBeTruthy();
    for (const host of ['127.0.0.1', '[::1]'])
      expect(
        assertLocalSeedAllowed({
          ...valid,
          DATABASE_URL: `postgresql://u:p@${host}:5432/mandaria_test`,
        }),
      ).toBeTruthy();
  });
  it('refuses production, remote databases and weak or shared passwords', () => {
    for (const env of [
      { ...valid, NODE_ENV: 'production' },
      { ...valid, NODE_ENV: 'staging' },
      {
        ...valid,
        DATABASE_URL: 'postgresql://u:p@db.example.com:5432/mandaria',
      },
      { ...valid, DATABASE_URL: 'not a url' },
      { ...valid, LOCAL_PROVIDER_ADMIN_PASSWORD: undefined },
      { ...valid, LOCAL_PROVIDER_ADMIN_PASSWORD: 'short' },
      { ...valid, BOOTSTRAP_ADMIN_PASSWORD: 'a'.repeat(32) },
    ])
      expect(() => assertLocalSeedAllowed(env)).toThrow();
  });
});
