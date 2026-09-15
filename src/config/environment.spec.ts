import { describe, it, expect } from 'vitest';
import { validateEnvironment } from './environment.js';
const valid = {
  DATABASE_URL: 'postgresql://localhost/mandaria',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  INTEGRATION_JWT_SECRET: 'c'.repeat(40),
};
describe('environment', () => {
  it('rejects missing critical values', () =>
    expect(() => validateEnvironment({})).toThrow('Invalid environment'));
  it('rejects equal secrets and wildcard CORS', () => {
    expect(() =>
      validateEnvironment({
        ...valid,
        JWT_REFRESH_SECRET: valid.JWT_ACCESS_SECRET,
      }),
    ).toThrow('differ');
    expect(() => validateEnvironment({ ...valid, CORS_ORIGINS: '*' })).toThrow(
      'origins',
    );
  });
  it('normalizes numeric durations', () =>
    expect(validateEnvironment(valid).JWT_ACCESS_EXPIRES_IN).toBe(900));
  it('requires a separate B2B signing key and limits token duration', () => {
    expect(() =>
      validateEnvironment({
        ...valid,
        INTEGRATION_JWT_SECRET: valid.JWT_ACCESS_SECRET,
      }),
    ).toThrow('differ');
    expect(() =>
      validateEnvironment({
        ...valid,
        INTEGRATION_ACCESS_TOKEN_EXPIRES_IN: 86400,
      }),
    ).toThrow('Invalid environment');
    expect(validateEnvironment(valid).INTEGRATION_ACCESS_TOKEN_EXPIRES_IN).toBe(
      3600,
    );
  });
});
