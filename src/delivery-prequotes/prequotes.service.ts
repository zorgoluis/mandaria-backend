import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  HttpException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type DeliveryPrequote } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { IntegrationAuthService } from '../integrations/integration-auth.service.js';
import { ServiceZonesService } from '../service-zones/service-zones.service.js';
import { RatePlansService } from '../rate-plans/rate-plans.service.js';
import { prepareQuotePricing } from '../pricing/quote-pricing.js';
import {
  ROUTING_PROVIDER,
  RoutingError,
  type RoutingProvider,
} from '../routing/routing.types.js';
import { DomainException } from '../common/domain-error.js';
import { PrequotePersistenceService } from './prequote-persistence.service.js';
import {
  normalizePrequoteConditions,
  prequoteEffectiveStatus,
} from './prequote-conditions.js';
import {
  PREQUOTE_CONSUMPTION,
  type PrequoteConsumption,
} from './prequote-consumption.js';
import { PrequotePublicError } from './prequote-errors.js';

export function prequoteView(q: DeliveryPrequote, now = new Date()) {
  return {
    publicId: q.publicId,
    status: prequoteEffectiveStatus(q, now),
    conditionsVersion: q.conditionsVersion,
    conditions: q.conditions,
    serviceZone: { code: q.zoneCode, name: q.zoneName },
    distanceMeters: q.distanceMeters,
    durationSeconds: q.durationSeconds,
    amount: q.amount.toFixed(2),
    currency: q.currency,
    createdAt: q.issuedAt,
    expiresAt: q.expiresAt,
    convertedAt: null,
    deliveryRequestPublicId: null,
    deliveryQuotePublicId: null,
    availabilityGuaranteed: false,
  };
}

@Injectable()
export class PrequotesService {
  private readonly logger = new Logger(PrequotesService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly persistence: PrequotePersistenceService,
    private readonly config: ConfigService,
    private readonly auth: IntegrationAuthService,
    private readonly zones: ServiceZonesService,
    private readonly plans: RatePlansService,
    @Inject(ROUTING_PROVIDER) private readonly routing: RoutingProvider,
    @Inject(PREQUOTE_CONSUMPTION)
    private readonly consumption: PrequoteConsumption,
  ) {}

  async get(publicId: string, integrationClientId: string) {
    const q = await this.prisma.deliveryPrequote.findFirst({
      where: { publicId, integrationClientId },
    });
    if (!q) throw new NotFoundException('Prequote not found');
    return prequoteView(q);
  }

  private enabled() {
    if (!this.config.getOrThrow<boolean>('PREQUOTE_ENABLED'))
      throw new PrequotePublicError('PREQUOTE_DISABLED');
  }
  private async authorize(token: string, integrationClientId: string) {
    const principal = await this.auth.authenticate(token);
    if (
      principal.id !== integrationClientId ||
      !principal.scopes.includes('prequotes:create')
    )
      throw new ForbiddenException('Insufficient integration scopes');
  }
  private resolve(
    result:
      | Awaited<ReturnType<PrequotePersistenceService['inspect']>>
      | Awaited<ReturnType<PrequotePersistenceService['reserve']>>,
  ) {
    if (result.kind === 'succeeded')
      return { prequote: prequoteView(result.prequote), replayed: true };
    if (result.kind === 'in_progress')
      throw new PrequotePublicError('PREQUOTE_IN_PROGRESS', result.retryAt);
    if (result.kind === 'failed')
      throw new PrequotePublicError(result.errorCode, undefined, true);
    return undefined;
  }

  async create(
    integrationClientId: string,
    token: string,
    key: string,
    input: unknown,
  ) {
    const conditions = normalizePrequoteConditions(input);
    if (!/^[\x21-\x7e]{8,255}$/.test(key))
      throw new DomainException(
        'IDEMPOTENCY_KEY_INVALID',
        400,
        'Idempotency-Key must contain 8–255 visible ASCII characters',
      );
    const existing = this.resolve(
      await this.persistence.inspect(integrationClientId, key, conditions),
    );
    if (existing) return existing;
    this.enabled();
    await this.authorize(token, integrationClientId);
    const admission = await this.consumption
      .admit(integrationClientId)
      .catch(() => {
        throw new PrequotePublicError('PREQUOTE_CONSUMPTION_UNAVAILABLE');
      });
    if (!admission.admitted)
      throw new PrequotePublicError(
        'PREQUOTE_CONSUMPTION_UNAVAILABLE',
        admission.retryAt,
      );
    let routingStarted = false;
    let published = false;
    try {
      // Admission may have waited; a disabled request must not acquire an attempt.
      this.enabled();
      const result = await this.persistence.reserve(
        integrationClientId,
        key,
        conditions,
        {
          leaseMs: this.config.getOrThrow<number>('PREQUOTE_LEASE_MS'),
          maxAttempts: this.config.getOrThrow<number>('PREQUOTE_MAX_ATTEMPTS'),
        },
      );
      const resolved = this.resolve(result);
      if (resolved) return resolved;
      if (result.kind !== 'acquired')
        throw new PrequotePublicError('PREQUOTE_EXECUTION_FAILED');
      try {
        const configuration = await this.prisma.$transaction(
          (tx) =>
            prepareQuotePricing(
              tx,
              conditions.stops[0],
              conditions.stops[1],
              'LOCAL_DELIVERY',
              { zones: this.zones, plans: this.plans },
            ),
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
        );
        if (configuration.plan.currency !== 'MXN')
          throw new PrequotePublicError('RATE_CONFIGURATION_INVALID');
        await this.authorize(token, integrationClientId);
        const retries = this.config.getOrThrow<number>(
          'GOOGLE_ROUTES_MAX_RETRIES',
        );
        const budget =
          this.config.getOrThrow<number>('GOOGLE_ROUTES_TIMEOUT_MS') *
            (retries + 1) +
          100 * retries * (retries + 1) +
          15000;
        this.enabled();
        await admission.permit.start();
        await this.authorize(token, integrationClientId);
        await this.persistence.requireRoutingBudget(result.lease, budget);
        this.enabled();
        routingStarted = true;
        // No transaction/lock is held here. Exactly one adapter invocation per attempt.
        const route = await this.routing.calculateRoute(
          {
            latitude: conditions.stops[0].latitude,
            longitude: conditions.stops[0].longitude,
          },
          {
            latitude: conditions.stops[1].latitude,
            longitude: conditions.stops[1].longitude,
          },
        );
        await this.authorize(token, integrationClientId);
        const prequote = await this.persistence
          .publish(
            result.lease,
            conditions,
            {
              serviceZoneId: configuration.zone.id,
              ratePlanId: configuration.plan.id,
              route,
            },
            this.config.getOrThrow<number>('PREQUOTE_VALIDITY_MS'),
          )
          .catch((error: unknown) => {
            if (
              error instanceof DomainException &&
              [
                'OUT_OF_SERVICE_AREA',
                'CROSS_ZONE_NOT_SUPPORTED',
                'RATE_CONFIGURATION_UNAVAILABLE',
                'RATE_CONFIGURATION_INVALID',
                'SERVICE_ZONE_AMBIGUOUS',
              ].includes(error.code)
            )
              throw new PrequotePublicError('PREQUOTE_CONFIGURATION_CHANGED');
            throw error;
          });
        published = true;
        return { prequote: prequoteView(prequote), replayed: false };
      } catch (error) {
        let code =
          error instanceof RoutingError
            ? error.code
            : error instanceof DomainException
              ? error.code
              : 'PREQUOTE_EXECUTION_FAILED';
        if (
          error instanceof HttpException &&
          [401, 403].includes(error.getStatus())
        )
          code = 'PREQUOTE_AUTHORIZATION_CHANGED';
        const retryable = ![
          'ROUTE_NOT_FOUND',
          'DISTANCE_NOT_SUPPORTED',
          'OUT_OF_SERVICE_AREA',
          'CROSS_ZONE_NOT_SUPPORTED',
          'PREQUOTE_AUTHORIZATION_CHANGED',
        ].includes(code);
        try {
          const failure = await this.persistence.fail(
            result.lease,
            code,
            retryable,
          );
          throw new PrequotePublicError(
            code,
            undefined,
            failure.state === 'FAILED',
          );
        } catch (failureError) {
          if (failureError instanceof PrequotePublicError) throw failureError;
          // A COMMIT response can be lost. Success is returned only after verifying durable evidence.
          const current = this.resolve(
            await this.persistence.inspect(
              integrationClientId,
              key,
              conditions,
            ),
          );
          if (current) {
            await this.authorize(token, integrationClientId);
            published = true;
            return current;
          }
          throw new PrequotePublicError('PREQUOTE_LEASE_LOST');
        }
      }
    } finally {
      try {
        await admission.permit.finish({ routingStarted, published });
      } catch {
        // A5 must reconcile permits durably after crashes/finalization errors. Never log vendor/body/token.
        this.logger.error({
          event: 'PREQUOTE_CONSUMPTION_FINALIZATION_FAILED',
          code: 'PREQUOTE_CONSUMPTION_UNAVAILABLE',
        });
      }
    }
  }
}
