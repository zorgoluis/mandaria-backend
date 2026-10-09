import { describe, it, expect } from 'vitest';
import {
  sampleTimes,
  locationFreshness,
} from '../src/location/location.service.js';
describe('GPS time semantics', () => {
  const captured = new Date('2026-10-01T00:00:00.000Z');
  const sample = {
    latitude: 0,
    longitude: 0,
    accuracyMeters: 100,
    capturedAt: captured.toISOString(),
    receivedAt: new Date(captured.getTime() + 45000).toISOString(),
    ...sampleTimes(captured, new Date(captured.getTime() + 45000)),
  };
  it('does not rejuvenate capture through late receipt', () => {
    expect(sample.freshUntil).toBe('2026-10-01T00:01:00.000Z');
    expect(sample.eraseAfter).toBe('2026-10-01T00:10:00.000Z');
  });
  it('bounds permitted future capture freshness by receipt', () => {
    expect(sampleTimes(new Date(captured.getTime() + 15000), captured)).toEqual(
      sampleTimes(captured, captured),
    );
  });
  it('keeps exact 60s recent, then stale, and hides at exactly 10min', () => {
    expect(
      locationFreshness(sample, new Date(captured.getTime() + 60000)),
    ).toBe('RECENT');
    expect(
      locationFreshness(sample, new Date(captured.getTime() + 60001)),
    ).toBe('STALE');
    expect(
      locationFreshness(sample, new Date(captured.getTime() + 599999)),
    ).toBe('STALE');
    expect(
      locationFreshness(sample, new Date(captured.getTime() + 600000)),
    ).toBe('UNAVAILABLE');
    expect(locationFreshness(null, captured)).toBe('UNAVAILABLE');
  });
});
