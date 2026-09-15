import { Injectable } from '@nestjs/common';
import type { GeoPoint } from '../geo/geometry.js';
import type { RouteResult, RoutingProvider } from './routing.types.js';

/**
 * LOCAL/TEST ONLY. Selected explicitly with ROUTING_PROVIDER=local_fake, which environment
 * validation rejects when NODE_ENV=production. It is never used as a fallback for Google.
 * Distance = great-circle distance × 1.3 (rough road factor), duration at 8 m/s.
 */
@Injectable()
export class LocalFakeRoutingProvider implements RoutingProvider {
  readonly name = 'local_fake';
  async calculateRoute(
    origin: GeoPoint,
    destination: GeoPoint,
  ): Promise<RouteResult> {
    const rad = (d: number) => (d * Math.PI) / 180;
    const dLat = rad(destination.latitude - origin.latitude);
    const dLng = rad(destination.longitude - origin.longitude);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(origin.latitude)) *
        Math.cos(rad(destination.latitude)) *
        Math.sin(dLng / 2) ** 2;
    const meters = 2 * 6371000 * Math.asin(Math.sqrt(a));
    const distanceMeters = Math.round(meters * 1.3);
    return {
      distanceMeters,
      durationSeconds: Math.round(distanceMeters / 8),
      routingProvider: this.name,
      calculatedAt: new Date(),
    };
  }
}
