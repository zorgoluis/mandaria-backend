import { describe, it, expect } from 'vitest';
import {
  consumptionRetryAt,
  validateConsumptionLimits,
  routingProtectionMs,
} from '../src/delivery-prequotes/consumption-policy.js';
import { validateEnvironment } from '../src/config/environment.js';
const c = {
  minute: 10,
  day: 500,
  concurrent: 2,
  globalUnits: 10000,
  reserveMs: 30000,
  retries: 1,
  timeoutMs: 5000,
};
const started = (at: number, units = 2) => ({
  integrationClientId: 'a',
  state: 'FINISHED' as const,
  reserveExpiresAt: new Date(at + 30000),
  startedAt: new Date(at),
  protectedUntil: new Date(at + 25200),
  units,
});
const valid = {
  DATABASE_URL: 'postgresql://localhost/main',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  INTEGRATION_JWT_SECRET: 'c'.repeat(40),
};
describe('A5 durable ledger projection and activation', () => {
  it('defaults disabled and requires explicit global units to enable', () => {
    expect(validateEnvironment(valid)).toMatchObject({
      PREQUOTE_ENABLED: false,
      PREQUOTE_PER_MINUTE: 10,
      PREQUOTE_PER_DAY: 500,
      PREQUOTE_MAX_CONCURRENT: 2,
    });
    expect(() =>
      validateEnvironment({ ...valid, PREQUOTE_ENABLED: 'true' }),
    ).toThrow('explicit');
    expect(() =>
      validateEnvironment({
        ...valid,
        PREQUOTE_ENABLED: 'true',
        PREQUOTE_GLOBAL_DAILY_ROUTING_UNITS: 1,
      }),
    ).toThrow();
    expect(
      validateEnvironment({
        ...valid,
        PREQUOTE_ENABLED: 'true',
        PREQUOTE_GLOBAL_DAILY_ROUTING_UNITS: 2,
      }).PREQUOTE_ENABLED,
    ).toBe(true);
  });
  it.each([0, NaN, Infinity, -1, 1.5, 1000001])(
    'rejects invalid global configuration %s',
    (globalUnits) => {
      expect(() => validateConsumptionLimits({ ...c, globalUnits })).toThrow();
    },
  );
  it('reserves maximum retries rather than one presumed billable call', () => {
    expect(routingProtectionMs(c)).toBe(25200);
    expect(routingProtectionMs({ ...c, retries: 2, timeoutMs: 15000 })).toBe(
      60600,
    );
    expect(
      consumptionRetryAt(
        [started(0, 2)],
        'a',
        { ...c, globalUnits: 3 },
        new Date(30000),
      ),
    ).toEqual(new Date(86400000));
  });
  it('minute boundary is rolling and exclusive at equality', () => {
    const rows = [started(1000)];
    expect(
      consumptionRetryAt(rows, 'a', { ...c, minute: 1 }, new Date(60999)),
    ).toEqual(new Date(61000));
    expect(
      consumptionRetryAt(rows, 'a', { ...c, minute: 1 }, new Date(61000)),
    ).toBeUndefined();
  });
  it('day boundary does not reset at UTC midnight', () => {
    const at = Date.parse('2026-09-28T23:59:59Z');
    expect(
      consumptionRetryAt(
        [started(at)],
        'a',
        { ...c, day: 1 },
        new Date(at + 2000),
      ),
    ).toEqual(new Date(at + 86400000));
    expect(
      consumptionRetryAt(
        [started(at)],
        'a',
        { ...c, day: 1 },
        new Date(at + 86400000),
      ),
    ).toBeUndefined();
  });
  it('uses latest release needed across all blocking limits', () => {
    const rows = [started(1000), started(2000)];
    expect(
      consumptionRetryAt(
        rows,
        'a',
        { ...c, minute: 1, day: 1, globalUnits: 2 },
        new Date(3000),
      ),
    ).toEqual(new Date(86402000));
  });
  it('weighted releases may require more than the earliest row to expire', () => {
    const rows = [started(1000, 1), started(2000, 3)];
    expect(
      consumptionRetryAt(
        rows,
        'b',
        { ...c, globalUnits: 4, retries: 2 },
        new Date(3000),
      ),
    ).toEqual(new Date(86402000));
  });
  it('reserved then cancelled has no external consumption; expired reservation releases capacity', () => {
    const r = {
      ...started(0),
      state: 'RESERVED' as const,
      startedAt: null,
      protectedUntil: null,
    };
    expect(
      consumptionRetryAt([r], 'a', { ...c, minute: 1 }, new Date(1)),
    ).toEqual(new Date(30000));
    expect(
      consumptionRetryAt([r], 'a', { ...c, minute: 1 }, new Date(30000)),
    ).toBeUndefined();
    expect(
      consumptionRetryAt(
        [{ ...r, state: 'CANCELLED' }],
        'a',
        { ...c, minute: 1 },
        new Date(1),
      ),
    ).toBeUndefined();
  });
  it('finish does not prematurely release potentially active slot', () => {
    expect(
      consumptionRetryAt(
        [started(0)],
        'a',
        { ...c, concurrent: 1 },
        new Date(1000),
      ),
    ).toEqual(new Date(25200));
    expect(
      consumptionRetryAt(
        [started(0)],
        'a',
        { ...c, concurrent: 1 },
        new Date(25200),
      ),
    ).toBeUndefined();
  });
  it('other integrations have independent quota and slots but share units', () => {
    const rows = [started(0)];
    expect(
      consumptionRetryAt(
        rows,
        'b',
        { ...c, minute: 1, concurrent: 1 },
        new Date(1),
      ),
    ).toBeUndefined();
    expect(
      consumptionRetryAt(rows, 'b', { ...c, globalUnits: 2 }, new Date(1)),
    ).toEqual(new Date(86400000));
  });
});
