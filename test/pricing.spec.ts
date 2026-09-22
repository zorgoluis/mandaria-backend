import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  boundariesIntersect,
  boundingBox,
  containsPoint,
  parseBoundary,
} from '../dist/geo/geometry.js';
import { findBand, validateBands } from '../dist/rate-plans/rate-bands.js';
import {
  GOOGLE_ROUTES_URL,
  GoogleRoutingProvider,
  parseGoogleRoute,
} from '../dist/routing/google-routing.provider.js';
import { RoutingError } from '../dist/routing/routing.types.js';
import { formatPublicId } from '../dist/common/public-id.js';
import {
  DeliveryQuotesService,
  quoteView,
} from '../dist/delivery-quotes/delivery-quotes.service.js';
import { validateEnvironment } from '../src/config/environment.js';

const square = (
  minLng: number,
  minLat: number,
  maxLng: number,
  maxLat: number,
) => [
  [minLng, minLat],
  [maxLng, minLat],
  [maxLng, maxLat],
  [minLng, maxLat],
  [minLng, minLat],
];
const polygon = (...rings: number[][][]) => ({
  type: 'Polygon',
  coordinates: rings,
});
const zone = parseBoundary(polygon(square(-93.41, 16.735, -93.34, 16.79)));

describe('service zone geometry', () => {
  it('rejects malformed GeoJSON boundaries', () => {
    for (const invalid of [
      null,
      { type: 'Point', coordinates: [-93, 16] },
      polygon([
        [-93, 16],
        [-92, 16],
        [-92, 17],
      ]),
      polygon([
        [-93, 16],
        [-92, 16],
        [-92, 17],
        [-93, 17],
      ]),
      polygon(square(-93, 16, -92, 91)),
      polygon([
        [-93, 16],
        [-92, 17],
        [-92, 16],
        [-93, 17],
        [-93, 16],
      ]),
      polygon([
        [-93, 16],
        [-92, 16],
        [-91, 16],
        [-93, 16],
      ]),
      polygon([
        [-93, 16],
        ['x', 16],
        [-92, 17],
        [-93, 16],
      ] as never),
      { type: 'MultiPolygon', coordinates: [] },
    ])
      expect(() => parseBoundary(invalid)).toThrow();
  });
  it('covers inside and border points, excludes outside points and holes', () => {
    expect(
      containsPoint(zone, { latitude: 16.7614, longitude: -93.3743 }),
    ).toBe(true);
    expect(containsPoint(zone, { latitude: 16.735, longitude: -93.38 })).toBe(
      true,
    );
    expect(containsPoint(zone, { latitude: 16.735, longitude: -93.41 })).toBe(
      true,
    );
    expect(
      containsPoint(zone, { latitude: 16.7534, longitude: -93.1159 }),
    ).toBe(false);
    expect(containsPoint(zone, { latitude: 16.8, longitude: -93.38 })).toBe(
      false,
    );
    const withHole = parseBoundary(
      polygon(square(0, 0, 10, 10), square(4, 4, 6, 6)),
    );
    expect(containsPoint(withHole, { latitude: 5, longitude: 5 })).toBe(false);
    expect(containsPoint(withHole, { latitude: 4, longitude: 5 })).toBe(true);
    expect(containsPoint(withHole, { latitude: 2, longitude: 2 })).toBe(true);
    const multi = parseBoundary({
      type: 'MultiPolygon',
      coordinates: [[square(0, 0, 1, 1)], [square(5, 5, 6, 6)]],
    });
    expect(containsPoint(multi, { latitude: 5.5, longitude: 5.5 })).toBe(true);
    expect(containsPoint(multi, { latitude: 3, longitude: 3 })).toBe(false);
    expect(boundingBox(multi)).toEqual({
      minLongitude: 0,
      maxLongitude: 6,
      minLatitude: 0,
      maxLatitude: 6,
    });
  });
  it('detects overlapping, touching and nested zones but not disjoint or hole-contained ones', () => {
    const a = parseBoundary(polygon(square(0, 0, 10, 10)));
    expect(
      boundariesIntersect(a, parseBoundary(polygon(square(5, 5, 15, 15)))),
    ).toBe(true);
    expect(
      boundariesIntersect(a, parseBoundary(polygon(square(10, 0, 20, 10)))),
    ).toBe(true);
    expect(
      boundariesIntersect(a, parseBoundary(polygon(square(2, 2, 3, 3)))),
    ).toBe(true);
    expect(
      boundariesIntersect(a, parseBoundary(polygon(square(11, 11, 20, 20)))),
    ).toBe(false);
    const donut = parseBoundary(
      polygon(square(0, 0, 10, 10), square(3, 3, 7, 7)),
    );
    expect(
      boundariesIntersect(donut, parseBoundary(polygon(square(4, 4, 6, 6)))),
    ).toBe(false);
  });
});

describe('DISTANCE_BANDS', () => {
  const band = (
    min: number,
    max: number,
    amount = '40.00',
    currency = 'MXN',
  ) => ({
    minDistanceMeters: min,
    maxDistanceMeters: max,
    amount,
    currency,
  });
  const bands = [
    band(0, 2000, '35'),
    band(2000, 4000, '40'),
    band(4000, 6000, '50'),
  ];
  it('uses [min, max) so boundary distances map to exactly one band', () => {
    expect(validateBands(bands, 'MXN').valid).toBe(true);
    const at = (d: number) => findBand(bands, d)?.amount;
    expect([at(0), at(1999), at(2000), at(3999), at(4000), at(5999)]).toEqual([
      '35',
      '35',
      '40',
      '40',
      '50',
      '50',
    ]);
    expect(at(6000)).toBeUndefined();
    expect(at(11400)).toBeUndefined();
  });
  it('rejects gaps, overlaps, bad starts, invalid ranges, non-positive amounts and mixed currencies', () => {
    const errors = (list: ReturnType<typeof band>[]) =>
      validateBands(list, 'MXN').errors.join(' | ');
    expect(errors([])).toMatch(/at least one band/);
    expect(errors([band(0, 2000), band(3000, 4000)])).toMatch(
      /gap between 2000 and 3000/,
    );
    expect(errors([band(0, 2500), band(2000, 4000)])).toMatch(/overlap/);
    expect(errors([band(100, 2000)])).toMatch(/start at 0/);
    expect(errors([band(0, 0)])).toMatch(/greater than minDistanceMeters/);
    expect(errors([band(0, 2000, '0')])).toMatch(
      /amount must be greater than 0/,
    );
    expect(errors([band(0, 2000, '-5')])).toMatch(
      /amount must be greater than 0/,
    );
    expect(errors([band(0, 2000, '10', 'USD')])).toMatch(
      /currency must be MXN/,
    );
    expect(
      validateBands(
        [band(0, 2000, '10', 'MXN')].map((b) => ({
          ...b,
          amount: new Prisma.Decimal('10.50'),
        })),
        'MXN',
      ).valid,
    ).toBe(true);
  });
});

describe('GoogleRoutingProvider', () => {
  const key = 'test-google-key-000000000000000';
  const config = (overrides: Record<string, unknown> = {}) =>
    new ConfigService({
      GOOGLE_ROUTES_API_KEY: key,
      GOOGLE_ROUTES_TIMEOUT_MS: 5000,
      GOOGLE_ROUTES_MAX_RETRIES: 1,
      GOOGLE_ROUTES_TRAVEL_MODE: 'DRIVE',
      ...overrides,
    });
  const json = (status: number, body: unknown) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
    });
  const origin = { latitude: 16.76, longitude: -93.37 };
  const destination = { latitude: 16.77, longitude: -93.36 };
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as RoutingError;
    }
    throw new Error('expected failure');
  };

  it('normalizes distance/duration and sends the key only in the header with a field mask', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      json(200, {
        routes: [{ distanceMeters: 4700, duration: '780s', polyline: 'x' }],
      }),
    );
    const route = await new GoogleRoutingProvider(
      config(),
      fetcher,
    ).calculateRoute(origin, destination);
    expect(route).toMatchObject({
      distanceMeters: 4700,
      durationSeconds: 780,
      routingProvider: 'google',
    });
    expect(Object.keys(route).sort()).toEqual([
      'calculatedAt',
      'distanceMeters',
      'durationSeconds',
      'routingProvider',
    ]);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(GOOGLE_ROUTES_URL);
    expect(url).not.toContain(key);
    expect(init.headers).toMatchObject({
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration',
    });
    expect(JSON.parse(init.body)).toMatchObject({
      origin: { location: { latLng: origin } },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_UNAWARE',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it('maps an empty route list to ROUTE_NOT_FOUND without retrying', async () => {
    for (const body of [{}, { routes: [] }]) {
      const fetcher = vi.fn().mockResolvedValue(json(200, body));
      const error = await failure(
        new GoogleRoutingProvider(config(), fetcher).calculateRoute(
          origin,
          destination,
        ),
      );
      expect(error).toMatchObject({ code: 'ROUTE_NOT_FOUND' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    expect(
      parseGoogleRoute({ routes: [{ duration: '0s' }] }, 'google')
        .distanceMeters,
    ).toBe(0);
  });
  it('retries timeouts, network errors, 429 and 5xx once, then reports ROUTING_UNAVAILABLE', async () => {
    const timeout = Object.assign(new Error('timed out'), {
      name: 'TimeoutError',
    });
    for (const [first, reason] of [
      [() => Promise.reject(timeout), 'TIMEOUT'],
      [() => Promise.reject(new TypeError('fetch failed')), 'NETWORK'],
      [() => Promise.resolve(json(503, { error: {} })), 'HTTP_503'],
      [() => Promise.resolve(json(429, { error: {} })), 'HTTP_429'],
    ] as const) {
      const fetcher = vi.fn().mockImplementation(first);
      const error = await failure(
        new GoogleRoutingProvider(config(), fetcher).calculateRoute(
          origin,
          destination,
        ),
      );
      expect(error).toBeInstanceOf(RoutingError);
      expect(error).toMatchObject({ code: 'ROUTING_UNAVAILABLE', reason });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(error.message).not.toContain(key);
    }
    const recovered = vi
      .fn()
      .mockResolvedValueOnce(json(500, {}))
      .mockResolvedValueOnce(
        json(200, { routes: [{ distanceMeters: 10, duration: '3s' }] }),
      );
    await expect(
      new GoogleRoutingProvider(config(), recovered).calculateRoute(
        origin,
        destination,
      ),
    ).resolves.toMatchObject({ distanceMeters: 10 });
  });
  it('does not retry request/key errors or invalid payloads and never guesses a distance', async () => {
    for (const [response, reason] of [
      [json(400, { error: { message: 'bad' } }), 'HTTP_400'],
      [json(403, { error: {} }), 'HTTP_403'],
      [json(200, 'not-json'), 'INVALID_RESPONSE'],
      [json(200, { routes: 'x' }), 'INVALID_RESPONSE'],
      [
        json(200, { routes: [{ distanceMeters: -5, duration: '10s' }] }),
        'INVALID_RESPONSE',
      ],
      [
        json(200, { routes: [{ distanceMeters: '4700', duration: '10s' }] }),
        'INVALID_RESPONSE',
      ],
      [json(200, { routes: [{ distanceMeters: 4700 }] }), 'INVALID_RESPONSE'],
    ] as const) {
      const fetcher = vi.fn().mockResolvedValue(response);
      const error = await failure(
        new GoogleRoutingProvider(config(), fetcher).calculateRoute(
          origin,
          destination,
        ),
      );
      expect(error).toMatchObject({ code: 'ROUTING_UNAVAILABLE', reason });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('reports NOT_CONFIGURED without calling Google when the key is missing', async () => {
    const fetcher = vi.fn();
    // ConfigService.get falls back to process.env; a key in the developer's .env must not leak in.
    vi.stubEnv('GOOGLE_ROUTES_API_KEY', '');
    try {
      const error = await failure(
        new GoogleRoutingProvider(
          config({ GOOGLE_ROUTES_API_KEY: undefined }),
          fetcher,
        ).calculateRoute(origin, destination),
      );
      expect(error).toMatchObject({
        code: 'ROUTING_UNAVAILABLE',
        reason: 'NOT_CONFIGURED',
      });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('V1.6 configuration and quote views', () => {
  const base = {
    DATABASE_URL: 'postgresql://localhost/test',
    JWT_ACCESS_SECRET: 'a'.repeat(40),
    JWT_REFRESH_SECRET: 'b'.repeat(40),
    INTEGRATION_JWT_SECRET: 'c'.repeat(40),
  };
  it('defaults routing settings and forbids fake/unconfigured routing in production', () => {
    expect(validateEnvironment(base)).toMatchObject({
      ROUTING_PROVIDER: 'google',
      GOOGLE_ROUTES_TIMEOUT_MS: 5000,
      GOOGLE_ROUTES_MAX_RETRIES: 1,
      GOOGLE_ROUTES_TRAVEL_MODE: 'DRIVE',
    });
    expect(
      validateEnvironment({ ...base, GOOGLE_ROUTES_API_KEY: '' })
        .GOOGLE_ROUTES_API_KEY,
    ).toBeUndefined();
    expect(() =>
      validateEnvironment({ ...base, NODE_ENV: 'production' }),
    ).toThrow(/GOOGLE_ROUTES_API_KEY/);
    expect(() =>
      validateEnvironment({
        ...base,
        NODE_ENV: 'production',
        ROUTING_PROVIDER: 'local_fake',
        GOOGLE_ROUTES_API_KEY: 'k'.repeat(30),
      }),
    ).toThrow(/local_fake/);
    expect(
      validateEnvironment({
        ...base,
        NODE_ENV: 'production',
        GOOGLE_ROUTES_API_KEY: 'k'.repeat(30),
        // V1.6.1: production also requires real mail delivery.
        MAIL_PROVIDER: 'smtp',
        SMTP_HOST: 'smtp.example.com',
        MAIL_FROM: 'Mandaria <no-reply@example.com>',
        MANDARIA_WEB_URL: 'https://app.example.com',
      }).ROUTING_PROVIDER,
    ).toBe('google');
    for (const bad of [
      { GOOGLE_ROUTES_TIMEOUT_MS: 100 },
      { GOOGLE_ROUTES_MAX_RETRIES: 5 },
      { ROUTING_PROVIDER: 'haversine' },
    ])
      expect(() => validateEnvironment({ ...base, ...bad })).toThrow();
  });
  it('formats MQ ids and reports stale OFFERED quotes as EXPIRED without changing the snapshot', () => {
    expect(formatPublicId('MQ', 42n)).toBe('MQ-000042');
    const row = {
      status: 'OFFERED',
      expiresAt: new Date('2026-09-15T12:15:00Z'),
      amount: new Prisma.Decimal('50'),
    } as never;
    expect(quoteView(row, new Date('2026-09-15T12:14:59Z'))).toMatchObject({
      status: 'OFFERED',
      amount: '50.00',
    });
    expect(quoteView(row, new Date('2026-09-15T12:15:00Z'))).toMatchObject({
      status: 'EXPIRED',
      amount: '50.00',
    });
    expect(
      quoteView(
        { ...(row as object), status: 'ACCEPTED' } as never,
        new Date('2030-01-01'),
      ),
    ).toMatchObject({ status: 'ACCEPTED' });
  });
});

/**
 * Regression for the 20-concurrent-quotes failure: inside the quote transaction, zone and rate
 * plan lookups ran on the global Prisma client. Each needed a second pool connection while the
 * transaction held its own plus the request lock, so with as many concurrent quotes as pool
 * connections every request waited 10 s and failed with P2024 (HTTP 500). Every lookup must run
 * on the transaction client.
 */
describe('Quote transaction runs every lookup on its own connection', () => {
  const D = (n: number) => new Prisma.Decimal(n);
  const build = (plan: unknown) => {
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValue([
          { id: 'req', status: 'CREATED', serviceType: 'LOCAL_DELIVERY' },
        ]),
      deliveryQuote: { findMany: vi.fn().mockResolvedValue([]) },
      deliveryStop: {
        findMany: vi.fn().mockResolvedValue([
          { type: 'PICKUP', latitude: D(16.7), longitude: D(-93.3) },
          { type: 'DROPOFF', latitude: D(16.71), longitude: D(-93.31) },
        ]),
      },
    };
    const zones = {
      resolveActive: vi.fn().mockResolvedValue([{ id: 'zone' }]),
    };
    const plans = { findActive: vi.fn().mockResolvedValue(plan) };
    const prisma = {
      $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    };
    const config = new ConfigService({
      GOOGLE_ROUTES_TIMEOUT_MS: 5000,
      GOOGLE_ROUTES_MAX_RETRIES: 1,
    });
    const routing = { name: 'fake', calculateRoute: vi.fn() };
    const service = new DeliveryQuotesService(
      prisma as never,
      zones as never,
      plans as never,
      routing as never,
      config,
    );
    return { service, tx, zones, plans, routing };
  };

  it('passes the transaction client to the zone and rate plan lookups', async () => {
    // No active plan: the quote stops right after the lookups, before any routing call.
    const { service, tx, zones, plans, routing } = build(null);
    await expect(service.quote('MDR-000001', 'client')).rejects.toMatchObject({
      response: { code: 'RATE_CONFIGURATION_UNAVAILABLE' },
    });
    expect(zones.resolveActive).toHaveBeenCalledTimes(2);
    for (const call of zones.resolveActive.mock.calls) expect(call[1]).toBe(tx);
    expect(plans.findActive).toHaveBeenCalledTimes(1);
    expect(plans.findActive.mock.calls[0][2]).toBe(tx);
    expect(routing.calculateRoute).not.toHaveBeenCalled();
  });
});
