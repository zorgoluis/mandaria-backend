import { rejectConvertedRequest } from '../delivery-prequotes/prequote-origin.js';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { DeliveryQuoteStatus, ServiceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { pageResult } from '../common/pagination.dto.js';
import { DomainException } from '../common/domain-error.js';
import { nextPublicId } from '../common/public-id.js';
import { ServiceZonesService } from '../service-zones/service-zones.service.js';
import { RatePlansService } from '../rate-plans/rate-plans.service.js';
import {
  QUOTE_FAILURES,
  fail,
  prepareQuotePricing,
  evaluateQuotePrice,
  buildDeliveryQuoteSnapshot,
} from '../pricing/quote-pricing.js';
import { ROUTING_PROVIDER, RoutingError } from '../routing/routing.types.js';
import type { RoutingProvider } from '../routing/routing.types.js';
import type { GeoPoint } from '../geo/geometry.js';
import { openDispatch } from '../dispatch/dispatch-policy.js';
import {
  AdminDeliveryQuoteListQueryDto,
  DeliveryQuoteListQueryDto,
} from './delivery-quotes.dto.js';

export { QUOTE_FAILURES } from '../pricing/quote-pricing.js';

export const quoteSelect = {
  prequoteConversion: {
    select: { prequote: { select: { zoneCode: true, zoneName: true } } },
  },
  id: true,
  publicId: true,
  deliveryRequestId: true,
  serviceType: true,
  serviceZoneId: true,
  ratePlanId: true,
  rateBandId: true,
  distanceMeters: true,
  durationSeconds: true,
  amount: true,
  currency: true,
  routingProvider: true,
  routeCalculatedAt: true,
  status: true,
  expiresAt: true,
  acceptedAt: true,
  expiredAt: true,
  cancelledAt: true,
  cancellationReason: true,
  createdAt: true,
  updatedAt: true,
  deliveryRequest: {
    select: { publicId: true, integrationClientId: true, status: true },
  },
  serviceZone: { select: { id: true, code: true, name: true } },
  ratePlan: { select: { id: true, version: true } },
  rateBand: {
    select: { id: true, minDistanceMeters: true, maxDistanceMeters: true },
  },
} as const;
type QuoteRow = Prisma.DeliveryQuoteGetPayload<{ select: typeof quoteSelect }>;

/**
 * Persisted snapshot → response. Never recalculates price. An OFFERED quote whose expiresAt has
 * passed is reported as EXPIRED even before the lazy transition is persisted.
 */
export function quoteView(row: QuoteRow, now = new Date()) {
  const effective: DeliveryQuoteStatus =
    row.status === 'OFFERED' && row.expiresAt <= now ? 'EXPIRED' : row.status;
  const { prequoteConversion, ...safe } = row;
  const source = prequoteConversion?.prequote;
  return {
    ...safe,
    serviceZone: source
      ? { ...row.serviceZone, code: source.zoneCode, name: source.zoneName }
      : row.serviceZone,
    status: effective,
    amount: row.amount.toFixed(2),
  };
}
/** B2B contract: no internal UUIDs, rate plan internals or routing vendor details. */
export function integrationQuoteView(row: QuoteRow, now = new Date()) {
  const v = quoteView(row, now);
  return {
    publicId: v.publicId,
    deliveryRequestPublicId: v.deliveryRequest.publicId,
    serviceType: v.serviceType,
    serviceZone: { code: v.serviceZone.code, name: v.serviceZone.name },
    distanceMeters: v.distanceMeters,
    durationSeconds: v.durationSeconds,
    amount: v.amount,
    currency: v.currency,
    status: v.status,
    createdAt: v.createdAt,
    expiresAt: v.expiresAt,
    acceptedAt: v.acceptedAt,
    cancelledAt: v.cancelledAt,
    cancellationReason: v.cancellationReason,
  };
}

@Injectable()
export class DeliveryQuotesService {
  private readonly logger = new Logger(DeliveryQuotesService.name);
  /** Transaction budget: worst-case routing time (timeouts, retries, backoff) plus margin. */
  private readonly txTimeoutMs: number;
  constructor(
    private readonly prisma: PrismaService,
    private readonly zones: ServiceZonesService,
    private readonly plans: RatePlansService,
    @Inject(ROUTING_PROVIDER) private readonly routing: RoutingProvider,
    private readonly config: ConfigService,
  ) {
    const timeout = config.getOrThrow<number>('GOOGLE_ROUTES_TIMEOUT_MS');
    const retries = config.getOrThrow<number>('GOOGLE_ROUTES_MAX_RETRIES');
    this.txTimeoutMs =
      timeout * (retries + 1) + 200 * ((retries * (retries + 1)) / 2) + 5000;
  }

  /**
   * Returns the current quote of a DeliveryRequest or prices a new one.
   * The request row is locked FOR UPDATE for the whole operation: concurrent calls wait and then
   * reuse the OFFERED/ACCEPTED quote instead of calling the routing provider again, and a
   * cancellation cannot interleave. Partial unique indexes back "one OFFERED" and "one ACCEPTED".
   */
  async quote(deliveryRequestPublicId: string, integrationClientId: string) {
    const events: Record<string, unknown>[] = [];
    try {
      const outcome = await this.prisma.$transaction(
        async (tx) => {
          const [request] = await tx.$queryRaw<
            { id: string; status: string; serviceType: ServiceType }[]
          >`SELECT id, status, "serviceType" FROM "DeliveryRequest" WHERE "publicId" = ${deliveryRequestPublicId} AND "integrationClientId" = ${integrationClientId}::uuid FOR UPDATE`;
          if (!request)
            throw new NotFoundException('Delivery request not found');
          await rejectConvertedRequest(
            tx,
            request.id,
            'PREQUOTE_REQUOTE_NOT_ALLOWED',
          );
          if (request.status !== 'CREATED')
            throw fail(
              'DELIVERY_REQUEST_NOT_QUOTABLE',
              'Only CREATED delivery requests can be quoted',
            );
          const now = new Date();
          const open = await tx.deliveryQuote.findMany({
            where: {
              deliveryRequestId: request.id,
              status: { in: ['OFFERED', 'ACCEPTED'] },
            },
            select: quoteSelect,
          });
          const accepted = open.find((q) => q.status === 'ACCEPTED');
          if (accepted) return { quote: accepted, reused: true };
          const offered = open.find((q) => q.status === 'OFFERED');
          if (offered && offered.expiresAt > now)
            return { quote: offered, reused: true };
          if (offered) {
            await tx.deliveryQuote.update({
              where: { id: offered.id },
              data: { status: 'EXPIRED', expiredAt: now },
            });
            events.push({
              event: 'DELIVERY_QUOTE_EXPIRED',
              quotePublicId: offered.publicId,
            });
          }
          const stops = await tx.deliveryStop.findMany({
            where: { deliveryRequestId: request.id },
            orderBy: { sequence: 'asc' },
            select: { type: true, latitude: true, longitude: true },
          });
          const point = (type: string): GeoPoint => {
            const stop = stops.find((s) => s.type === type)!;
            return {
              latitude: stop.latitude.toNumber(),
              longitude: stop.longitude.toNumber(),
            };
          };
          const pickup = point('PICKUP');
          const dropoff = point('DROPOFF');

          const configuration = await prepareQuotePricing(
            tx,
            pickup,
            dropoff,
            request.serviceType,
            { zones: this.zones, plans: this.plans },
          );
          const { plan } = configuration;

          const route = await this.route(
            pickup,
            dropoff,
            deliveryRequestPublicId,
          );
          const price = evaluateQuotePrice(configuration, route);
          const created = await tx.deliveryQuote.create({
            data: buildDeliveryQuoteSnapshot(
              {
                publicId: await nextPublicId(tx, 'MQ'),
                deliveryRequestId: request.id,
                serviceType: request.serviceType,
              },
              configuration,
              route,
              price,
              {
                createdAt: now,
                expiresAt: new Date(
                  now.getTime() + plan.quoteValidityMinutes * 60_000,
                ),
              },
            ),
            select: quoteSelect,
          });
          events.push({
            event: 'DELIVERY_QUOTE_CREATED',
            quotePublicId: created.publicId,
            ratePlanId: plan.id,
            ratePlanVersion: plan.version,
            distanceMeters: route.distanceMeters,
            amount: created.amount.toFixed(2),
            currency: created.currency,
          });
          return { quote: created, reused: false };
        },
        { timeout: this.txTimeoutMs, maxWait: 10_000 },
      );
      for (const event of events)
        this.logger.log({
          ...event,
          deliveryRequestPublicId,
          integrationClientId,
          actorType: 'INTEGRATION',
          actorId: integrationClientId,
        });
      return outcome;
    } catch (error) {
      if (error instanceof DomainException && error.code in QUOTE_FAILURES)
        this.logger.warn({
          event: 'DELIVERY_QUOTE_FAILED',
          reasonCode: error.code,
          deliveryRequestPublicId,
          integrationClientId,
        });
      throw error;
    }
  }

  private async route(
    origin: GeoPoint,
    destination: GeoPoint,
    deliveryRequestPublicId: string,
  ) {
    const started = Date.now();
    try {
      const route = await this.routing.calculateRoute(origin, destination);
      this.logger.log({
        event: 'ROUTING_CALCULATED',
        routingProvider: this.routing.name,
        latencyMs: Date.now() - started,
        deliveryRequestPublicId,
      });
      return route;
    } catch (error) {
      const routingError =
        error instanceof RoutingError
          ? error
          : new RoutingError('ROUTING_UNAVAILABLE', 'UNEXPECTED');
      this.logger.warn({
        event: 'ROUTING_FAILED',
        routingProvider: this.routing.name,
        latencyMs: Date.now() - started,
        reason: routingError.reason,
        deliveryRequestPublicId,
      });
      throw fail(
        routingError.code,
        routingError.code === 'ROUTE_NOT_FOUND'
          ? 'No drivable route between pickup and dropoff'
          : 'Routing provider unavailable; retry later',
      );
    }
  }

  /**
   * OFFERED → ACCEPTED for the owning IntegrationClient. Serialized on the DeliveryRequest row;
   * repeating on an ACCEPTED quote is idempotent. A quote past expiresAt is persisted as EXPIRED
   * and rejected.
   */
  async accept(quotePublicId: string, integrationClientId: string) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const [owned] = await tx.$queryRaw<
        { id: string; deliveryRequestId: string }[]
      >`SELECT q.id, q."deliveryRequestId" FROM "DeliveryQuote" q JOIN "DeliveryRequest" r ON r.id = q."deliveryRequestId" WHERE q."publicId" = ${quotePublicId} AND r."integrationClientId" = ${integrationClientId}::uuid`;
      if (!owned) throw new NotFoundException('Delivery quote not found');
      const [request] = await tx.$queryRaw<
        { status: string }[]
      >`SELECT status FROM "DeliveryRequest" WHERE id = ${owned.deliveryRequestId}::uuid FOR UPDATE`;
      await rejectConvertedRequest(tx, owned.deliveryRequestId);
      const quote = await tx.deliveryQuote.findUniqueOrThrow({
        where: { id: owned.id },
        select: quoteSelect,
      });
      if (quote.status === 'ACCEPTED')
        return { quote, kind: 'already' as const };
      if (quote.status === 'EXPIRED')
        throw new DomainException(
          'QUOTE_EXPIRED',
          409,
          'Quote has expired; request a new quote',
        );
      if (quote.status === 'CANCELLED' || request.status !== 'CREATED')
        throw new DomainException(
          'QUOTE_NOT_ACCEPTABLE',
          409,
          'Quote or delivery request is no longer acceptable',
        );
      const now = new Date();
      if (now >= quote.expiresAt) {
        const expired = await tx.deliveryQuote.update({
          where: { id: quote.id },
          data: { status: 'EXPIRED', expiredAt: now },
          select: quoteSelect,
        });
        return { quote: expired, kind: 'expired' as const };
      }
      const accepted = await tx.deliveryQuote.update({
        where: { id: quote.id },
        data: { status: 'ACCEPTED', acceptedAt: now },
        select: quoteSelect,
      });
      // V1.7: same transaction, so an ACCEPTED quote never exists without its dispatch; the
      // unique deliveryQuoteId makes a repeated acceptance unable to open a second one.
      const dispatch = await openDispatch(
        tx,
        accepted,
        this.config.getOrThrow<number>('DISPATCH_TTL_MINUTES'),
        now,
      );
      return { quote: accepted, kind: 'accepted' as const, dispatch };
    });
    const base = {
      quotePublicId,
      deliveryRequestPublicId: outcome.quote.deliveryRequest.publicId,
      integrationClientId,
      actorType: 'INTEGRATION',
      actorId: integrationClientId,
    };
    if (outcome.kind === 'expired') {
      this.logger.log({ event: 'DELIVERY_QUOTE_EXPIRED', ...base });
      throw new DomainException(
        'QUOTE_EXPIRED',
        409,
        'Quote has expired; request a new quote',
      );
    }
    if (outcome.kind === 'accepted') {
      this.logger.log({
        event: 'DELIVERY_QUOTE_ACCEPTED',
        ...base,
        amount: outcome.quote.amount.toFixed(2),
        currency: outcome.quote.currency,
      });
      this.logger.log({
        event: 'DISPATCH_OPENED',
        dispatchId: outcome.dispatch.id,
        deliveryRequestId: outcome.quote.deliveryRequestId,
        deliveryQuoteId: outcome.quote.id,
        serviceZoneId: outcome.quote.serviceZoneId,
        serviceType: outcome.quote.serviceType,
        candidateCount: outcome.dispatch.providerIds.length,
        noProviderAvailable: outcome.dispatch.providerIds.length === 0,
        // V1.10-C: the frozen cost per actor (evidence of which policy version produced it).
        creditCosts: outcome.dispatch.creditSnapshots.map((s) => ({
          actorType: s.actorType,
          credits: s.credits,
          policyVersion: s.policyVersion,
          calculationType: s.calculationType,
        })),
        expiresAt: outcome.dispatch.expiresAt.toISOString(),
        actorType: 'INTEGRATION',
        actorId: integrationClientId,
      });
    }
    return outcome.quote;
  }

  async getOwned(quotePublicId: string, integrationClientId: string) {
    const quote = await this.prisma.deliveryQuote.findFirst({
      where: {
        publicId: quotePublicId,
        deliveryRequest: { integrationClientId },
      },
      select: quoteSelect,
    });
    if (!quote) throw new NotFoundException('Delivery quote not found');
    return quote;
  }

  async get(quotePublicId: string) {
    const quote = await this.prisma.deliveryQuote.findUnique({
      where: { publicId: quotePublicId },
      select: quoteSelect,
    });
    if (!quote) throw new NotFoundException('Delivery quote not found');
    return quote;
  }

  /** Quotes of one request (newest first). integrationClientId scopes B2B callers. */
  async listForRequest(
    deliveryRequestPublicId: string,
    query: DeliveryQuoteListQueryDto,
    integrationClientId?: string,
  ) {
    const request = await this.prisma.deliveryRequest.findFirst({
      where: { publicId: deliveryRequestPublicId, integrationClientId },
      select: { id: true },
    });
    if (!request) throw new NotFoundException('Delivery request not found');
    return this.page({ deliveryRequestId: request.id }, query);
  }

  list(query: AdminDeliveryQuoteListQueryDto) {
    const now = new Date();
    const statusFilter: Prisma.DeliveryQuoteWhereInput =
      query.status === 'OFFERED'
        ? { status: 'OFFERED', expiresAt: { gt: now } }
        : query.status === 'EXPIRED'
          ? {
              OR: [
                { status: 'EXPIRED' },
                { status: 'OFFERED', expiresAt: { lte: now } },
              ],
            }
          : { status: query.status };
    return this.page(
      {
        AND: [
          statusFilter,
          {
            publicId: query.publicId,
            serviceZoneId: query.serviceZoneId,
            deliveryRequest: {
              publicId: query.deliveryRequestPublicId,
              integrationClientId: query.integrationClientId,
            },
            createdAt:
              query.createdFrom || query.createdTo
                ? {
                    gte: query.createdFrom
                      ? new Date(query.createdFrom)
                      : undefined,
                    lte: query.createdTo
                      ? new Date(query.createdTo)
                      : undefined,
                  }
                : undefined,
          },
        ],
      },
      query,
    );
  }

  private async page(
    where: Prisma.DeliveryQuoteWhereInput,
    query: DeliveryQuoteListQueryDto,
  ) {
    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.deliveryQuote.findMany({
          where,
          select: quoteSelect,
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
        this.prisma.deliveryQuote.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return pageResult(items, total, query);
  }
}
