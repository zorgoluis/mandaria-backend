import { ConfigService } from '@nestjs/config';
import type { GeoPoint } from '../geo/geometry.js';
import { RoutingError } from './routing.types.js';
import type { RouteResult, RoutingProvider } from './routing.types.js';

export const GOOGLE_ROUTES_URL =
  'https://routes.googleapis.com/directions/v2:computeRoutes';
type Fetch = typeof fetch;

/**
 * Google Routes API (computeRoutes). The API key travels only in the X-Goog-Api-Key header and
 * is never logged or returned. A field mask limits the response (and billing) to distance and
 * duration. Retries: at most GOOGLE_ROUTES_MAX_RETRIES extra attempts, only for timeouts,
 * network errors, 429 and 5xx, with a short linear backoff.
 */
export class GoogleRoutingProvider implements RoutingProvider {
  readonly name = 'google';
  constructor(
    private readonly config: ConfigService,
    private readonly fetcher: Fetch = globalThis.fetch.bind(globalThis),
  ) {}

  async calculateRoute(
    origin: GeoPoint,
    destination: GeoPoint,
  ): Promise<RouteResult> {
    const apiKey = this.config.get<string>('GOOGLE_ROUTES_API_KEY');
    if (!apiKey)
      throw new RoutingError('ROUTING_UNAVAILABLE', 'NOT_CONFIGURED');
    const timeoutMs = this.config.getOrThrow<number>(
      'GOOGLE_ROUTES_TIMEOUT_MS',
    );
    const retries = this.config.getOrThrow<number>('GOOGLE_ROUTES_MAX_RETRIES');
    const body = JSON.stringify({
      origin: { location: { latLng: origin } },
      destination: { location: { latLng: destination } },
      travelMode: this.config.getOrThrow<string>('GOOGLE_ROUTES_TRAVEL_MODE'),
      routingPreference: 'TRAFFIC_UNAWARE',
      units: 'METRIC',
    });
    let last: RoutingError | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 200 * attempt));
      try {
        return await this.attempt(apiKey, body, timeoutMs);
      } catch (error) {
        last =
          error instanceof RoutingError
            ? error
            : new RoutingError('ROUTING_UNAVAILABLE', 'UNEXPECTED');
        if (!(error instanceof RoutingError && TRANSIENT.test(error.reason)))
          break;
      }
    }
    throw last!;
  }

  private async attempt(apiKey: string, body: string, timeoutMs: number) {
    let response: Response;
    try {
      response = await this.fetcher(GOOGLE_ROUTES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration',
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timeout =
        error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new RoutingError(
        'ROUTING_UNAVAILABLE',
        timeout ? 'TIMEOUT' : 'NETWORK',
      );
    }
    if (!response.ok) {
      // 4xx other than 429 mean request/key problems: not a missing route, not retried.
      throw new RoutingError('ROUTING_UNAVAILABLE', `HTTP_${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new RoutingError('ROUTING_UNAVAILABLE', 'INVALID_RESPONSE');
    }
    return parseGoogleRoute(payload, this.name);
  }
}
const TRANSIENT = /^(TIMEOUT|NETWORK|HTTP_429|HTTP_5\d\d)$/;

/** Google returns 200 with no routes when points are not connected by road. */
export function parseGoogleRoute(
  payload: unknown,
  provider: string,
): RouteResult {
  if (!payload || typeof payload !== 'object')
    throw new RoutingError('ROUTING_UNAVAILABLE', 'INVALID_RESPONSE');
  const routes = (payload as { routes?: unknown }).routes;
  if (routes === undefined || (Array.isArray(routes) && routes.length === 0))
    throw new RoutingError('ROUTE_NOT_FOUND', 'NO_ROUTES');
  if (!Array.isArray(routes))
    throw new RoutingError('ROUTING_UNAVAILABLE', 'INVALID_RESPONSE');
  const route = routes[0] as { distanceMeters?: unknown; duration?: unknown };
  // distanceMeters is omitted by Google when it is 0 (same point).
  const distance = route.distanceMeters ?? 0;
  const duration =
    typeof route.duration === 'string' && /^\d+(\.\d+)?s$/.test(route.duration)
      ? Math.round(Number(route.duration.slice(0, -1)))
      : undefined;
  if (
    typeof distance !== 'number' ||
    !Number.isInteger(distance) ||
    distance < 0 ||
    duration === undefined
  )
    throw new RoutingError('ROUTING_UNAVAILABLE', 'INVALID_RESPONSE');
  return {
    distanceMeters: distance,
    durationSeconds: duration,
    routingProvider: provider,
    calculatedAt: new Date(),
  };
}
