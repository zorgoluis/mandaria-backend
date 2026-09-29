import type {
  Prisma,
  RatePlan,
  RateBand,
  ServiceZone,
  ServiceType,
} from '@prisma/client';
import { DomainException } from '../common/domain-error.js';
import type { GeoPoint } from '../geo/geometry.js';
import type { RouteResult } from '../routing/routing.types.js';
import type { ServiceZonesService } from '../service-zones/service-zones.service.js';
import type { RatePlansService } from '../rate-plans/rate-plans.service.js';
import { findBand, validateBands } from '../rate-plans/rate-bands.js';

/** Failure codes returned to clients and audited as DELIVERY_QUOTE_FAILED. No quote is created. */
export const QUOTE_FAILURES = {
  OUT_OF_SERVICE_AREA: 422,
  CROSS_ZONE_NOT_SUPPORTED: 422,
  ROUTE_NOT_FOUND: 422,
  DISTANCE_NOT_SUPPORTED: 422,
  ROUTING_UNAVAILABLE: 503,
  RATE_CONFIGURATION_UNAVAILABLE: 503,
  RATE_CONFIGURATION_INVALID: 503,
  SERVICE_ZONE_AMBIGUOUS: 503,
  DELIVERY_REQUEST_NOT_QUOTABLE: 409,
} as const;
type FailureCode = keyof typeof QUOTE_FAILURES;
export const fail = (code: FailureCode, message: string) =>
  new DomainException(code, QUOTE_FAILURES[code], message);

type PricingBand = Pick<
  RateBand,
  'id' | 'minDistanceMeters' | 'maxDistanceMeters' | 'amount' | 'currency'
>;
export type QuotePricingConfiguration = {
  zone: Pick<ServiceZone, 'id' | 'currency'>;
  plan: Pick<
    RatePlan,
    'id' | 'version' | 'calculationType' | 'currency' | 'quoteValidityMinutes'
  > & { bands: PricingBand[] };
};

/** Configuration queries stay on the caller's transaction; this function never opens one. */
export async function prepareQuotePricing(
  tx: Prisma.TransactionClient,
  origin: GeoPoint,
  destination: GeoPoint,
  serviceType: ServiceType,
  lookups: {
    zones: Pick<ServiceZonesService, 'resolveActive'>;
    plans: Pick<RatePlansService, 'findActive'>;
  },
): Promise<QuotePricingConfiguration> {
  // Every query of this transaction runs on `tx`. A lookup on the global client would need a
  // second pool connection while this one holds the request lock; with as many concurrent
  // quotes as pool connections, all of them wait on that lock and the holder waits on the
  // pool, until the 10 s pool timeout fails every request (P2024 -> 500).
  const pickupZones = await lookups.zones.resolveActive(origin, tx);
  const dropoffZones = await lookups.zones.resolveActive(destination, tx);
  if (!pickupZones.length || !dropoffZones.length)
    throw fail(
      'OUT_OF_SERVICE_AREA',
      `${pickupZones.length ? 'Dropoff' : 'Pickup'} is outside every active service zone`,
    );
  if (pickupZones.length > 1 || dropoffZones.length > 1)
    throw fail(
      'SERVICE_ZONE_AMBIGUOUS',
      'A stop matches more than one active service zone',
    );
  const zone = pickupZones[0];
  if (zone.id !== dropoffZones[0].id)
    throw fail(
      'CROSS_ZONE_NOT_SUPPORTED',
      `${serviceType} requires pickup and dropoff in the same service zone`,
    );

  // Rate configuration is checked before routing to avoid paid calls that cannot be priced.
  const plan = await lookups.plans.findActive(zone.id, serviceType, tx);
  if (!plan)
    throw fail(
      'RATE_CONFIGURATION_UNAVAILABLE',
      'No active rate plan for this zone and service type',
    );

  validateQuoteRatePlan({ zone, plan });
  return { zone, plan };
}

/** Must run before routing. Preserve legacy validation and error precedence. */
export function validateQuoteRatePlan({
  zone,
  plan,
}: QuotePricingConfiguration) {
  if (
    plan.calculationType !== 'DISTANCE_BANDS' ||
    plan.currency !== zone.currency ||
    !validateBands(plan.bands, plan.currency).valid
  )
    throw fail(
      'RATE_CONFIGURATION_INVALID',
      'Active rate plan is inconsistent',
    );
}

/** Pure evaluation: no routing, database, clock or alternate monetary arithmetic. */
export function evaluateQuotePrice(
  configuration: QuotePricingConfiguration,
  route: RouteResult,
) {
  const band = findBand(configuration.plan.bands, route.distanceMeters);
  if (!band)
    throw fail(
      'DISTANCE_NOT_SUPPORTED',
      'Route distance exceeds the supported rate bands',
    );
  return { band, amount: band.amount, currency: band.currency };
}

/** Legacy persistence data, with issuance and expiry supplied by its orchestrator. */
export function buildDeliveryQuoteSnapshot(
  identity: {
    publicId: string;
    deliveryRequestId: string;
    serviceType: ServiceType;
  },
  configuration: QuotePricingConfiguration,
  route: RouteResult,
  price: ReturnType<typeof evaluateQuotePrice>,
  times: { createdAt: Date; expiresAt: Date },
) {
  return {
    publicId: identity.publicId,
    deliveryRequestId: identity.deliveryRequestId,
    serviceType: identity.serviceType,
    serviceZoneId: configuration.zone.id,
    ratePlanId: configuration.plan.id,
    rateBandId: price.band.id,
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    amount: price.amount,
    currency: price.currency,
    routingProvider: route.routingProvider,
    routeCalculatedAt: route.calculatedAt,
    createdAt: times.createdAt,
    expiresAt: times.expiresAt,
  } satisfies Prisma.DeliveryQuoteUncheckedCreateInput;
}
