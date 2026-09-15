import type { GeoPoint } from '../geo/geometry.js';

/** Normalized route used for pricing. Raw provider payloads are never stored. */
export type RouteResult = {
  distanceMeters: number;
  durationSeconds: number;
  routingProvider: string;
  calculatedAt: Date;
};

/**
 * Pricing depends only on this contract, never on a vendor SDK/HTTP API.
 * Implementations: GoogleRoutingProvider (V1.6); Mapbox/HERE/OSRM can be added later.
 */
export interface RoutingProvider {
  readonly name: string;
  calculateRoute(origin: GeoPoint, destination: GeoPoint): Promise<RouteResult>;
}
export const ROUTING_PROVIDER = Symbol('ROUTING_PROVIDER');

/**
 * ROUTE_NOT_FOUND: the provider answered and there is no usable route.
 * ROUTING_UNAVAILABLE: timeout, 5xx/429, network, misconfiguration or invalid response.
 * Never fall back to straight-line distance for pricing.
 */
export type RoutingErrorCode = 'ROUTE_NOT_FOUND' | 'ROUTING_UNAVAILABLE';
export class RoutingError extends Error {
  constructor(
    readonly code: RoutingErrorCode,
    /** Internal detail for logs only (TIMEOUT, HTTP_503, INVALID_RESPONSE, NOT_CONFIGURED…). */
    readonly reason: string,
  ) {
    super(`${code}: ${reason}`);
  }
}
