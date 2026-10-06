import {
  shippingSnapshot,
  type ShippingPayer,
} from '../customers/shipping-terms.js';
import {
  demandOwner,
  ownerFields,
  ownerKey,
  ownerSql,
} from '../customers/demand-owner.js';
import type { DemandOwnerInput } from '../customers/demand-owner.js';
import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { fingerprint } from '../idempotency/idempotency.service.js';
import { DomainException } from '../common/domain-error.js';
import { nextPublicId } from '../common/public-id.js';
import { ServiceZonesService } from '../service-zones/service-zones.service.js';
import { RatePlansService } from '../rate-plans/rate-plans.service.js';
import {
  prepareQuotePricing,
  evaluateQuotePrice,
} from '../pricing/quote-pricing.js';
import type { RouteResult } from '../routing/routing.types.js';
import { normalizePrequoteConditions } from './prequote-conditions.js';

export const PREQUOTE_OPERATION = 'delivery_prequotes.create';
export const PREQUOTE_RESOURCE = 'DeliveryPrequote';
export type PrequoteLease = {
  recordId: string;
  integrationClientId: DemandOwnerInput;
  owner: string;
  version: number;
};
export type LeasePolicy = { leaseMs: number; maxAttempts: number };
const conflict = () =>
  new ConflictException(
    'Idempotency-Key was already used with a different request',
  );
const lost = () =>
  new DomainException(
    'PREQUOTE_LEASE_LOST',
    409,
    'Prequote execution lease is no longer owned',
  );
const validDuration = (n: number, max: number) =>
  Number.isSafeInteger(n) && n >= 1 && n <= max;
async function dbNow(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<
    { now: Date }[]
  >`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS now`;
  return row.now;
}

/** Internal only. No controllers, routing, workers or quotas; ApiIdempotencyRecord owns every key. */
@Injectable()
export class PrequotePersistenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly zones: ServiceZonesService,
    private readonly plans: RatePlansService,
  ) {}

  /** Read-only coherent observation; never acquires work or consumes an attempt. */
  async inspect(
    integrationClientId: DemandOwnerInput,
    key: string,
    input: unknown,
    shippingPayer?: ShippingPayer,
  ) {
    const conditions = normalizePrequoteConditions(
      input,
      demandOwner(integrationClientId).kind === 'CUSTOMER',
    );
    const requestHash = fingerprint(
      PREQUOTE_OPERATION,
      demandOwner(integrationClientId).kind === 'CUSTOMER'
        ? { conditions, shippingPayer: shippingPayer ?? 'REQUESTER' }
        : conditions,
    );
    return this.prisma.$transaction(
      async (tx) => {
        const record = await tx.apiIdempotencyRecord.findUnique({
          where: { ...ownerKey(integrationClientId, key) },
          include: { execution: true },
        });
        if (!record) return { kind: 'available' as const };
        if (
          record.operation !== PREQUOTE_OPERATION ||
          record.resourceType !== PREQUOTE_RESOURCE ||
          record.requestHash !== requestHash ||
          !record.execution
        )
          throw conflict();
        const execution = record.execution;
        if (execution.state === 'SUCCEEDED')
          return {
            kind: 'succeeded' as const,
            prequote: await tx.deliveryPrequote.findUniqueOrThrow({
              where: { id: record.resourceId },
            }),
          };
        if (execution.state === 'FAILED')
          return { kind: 'failed' as const, errorCode: execution.errorCode! };
        if (
          execution.state === 'PROCESSING' &&
          execution.leaseExpiresAt > (await dbNow(tx))
        )
          return {
            kind: 'in_progress' as const,
            retryAt: execution.leaseExpiresAt,
          };
        if (execution.attempts >= execution.maxAttempts)
          return { kind: 'failed' as const, errorCode: 'ATTEMPTS_EXHAUSTED' };
        return { kind: 'available' as const };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async requireRoutingBudget(lease: PrequoteLease, remainingMs: number) {
    await this.prisma.$transaction(async (tx) => {
      const { execution, now } = await this.owned(tx, lease);
      if (execution.leaseExpiresAt.getTime() - now.getTime() < remainingMs)
        throw new DomainException(
          'PREQUOTE_LEASE_BUDGET_INSUFFICIENT',
          409,
          'Retry this intention after its current execution finishes',
        );
    });
  }

  async reserve(
    integrationClientId: DemandOwnerInput,
    key: string,
    input: unknown,
    policy: LeasePolicy,
    shippingPayer?: ShippingPayer,
  ) {
    const conditions = normalizePrequoteConditions(
      input,
      demandOwner(integrationClientId).kind === 'CUSTOMER',
    );
    if (
      !/^[\x21-\x7e]{8,255}$/.test(key) ||
      !validDuration(policy.leaseMs, 300_000) ||
      !validDuration(policy.maxAttempts, 5)
    )
      throw new DomainException(
        'PREQUOTE_POLICY_INVALID',
        400,
        'Invalid internal lease policy or key',
      );
    const requestHash = fingerprint(
      PREQUOTE_OPERATION,
      demandOwner(integrationClientId).kind === 'CUSTOMER'
        ? { conditions, shippingPayer: shippingPayer ?? 'REQUESTER' }
        : conditions,
    );
    return this.prisma.$transaction(async (tx) => {
      const inserted = await tx.apiIdempotencyRecord.createMany({
        data: {
          id: randomUUID(),
          ...ownerFields(integrationClientId),
          key,
          operation: PREQUOTE_OPERATION,
          resourceType: PREQUOTE_RESOURCE,
          resourceId: randomUUID(),
          requestHash,
        },
        skipDuplicates: true,
      });
      const [record] = await tx.$queryRaw<
        {
          id: string;
          operation: string;
          resourceType: string;
          requestHash: string;
          resourceId: string;
        }[]
      >`SELECT * FROM "ApiIdempotencyRecord" WHERE ${ownerSql(integrationClientId)} AND key=${key} FOR UPDATE`;
      if (
        record.operation !== PREQUOTE_OPERATION ||
        record.resourceType !== PREQUOTE_RESOURCE ||
        record.requestHash !== requestHash
      )
        throw conflict();
      await tx.$queryRaw`SELECT "recordId" FROM "ApiIdempotencyExecution" WHERE "recordId"=${record.id}::uuid FOR UPDATE`;
      const now = await dbNow(tx);
      let execution = await tx.apiIdempotencyExecution.findUnique({
        where: { recordId: record.id },
      });
      if (inserted.count === 1) {
        execution = await tx.apiIdempotencyExecution.create({
          data: {
            recordId: record.id,
            state: 'PROCESSING',
            owner: randomUUID(),
            version: 1,
            attempts: 1,
            maxAttempts: policy.maxAttempts,
            leaseExpiresAt: new Date(now.getTime() + policy.leaseMs),
          },
        });
      } else {
        if (!execution) throw conflict(); // Never attach durable metadata to a legacy record.
        if (execution.state === 'SUCCEEDED')
          return {
            kind: 'succeeded' as const,
            prequote: await tx.deliveryPrequote.findUniqueOrThrow({
              where: { id: record.resourceId },
            }),
          };
        if (execution.state === 'FAILED')
          return { kind: 'failed' as const, errorCode: execution.errorCode! };
        if (execution.state === 'PROCESSING' && execution.leaseExpiresAt > now)
          return {
            kind: 'in_progress' as const,
            retryAt: execution.leaseExpiresAt,
          };
        if (execution.attempts >= execution.maxAttempts) {
          await tx.apiIdempotencyExecution.update({
            where: { recordId: record.id },
            data: { state: 'FAILED', errorCode: 'ATTEMPTS_EXHAUSTED' },
          });
          return { kind: 'failed' as const, errorCode: 'ATTEMPTS_EXHAUSTED' };
        }
        execution = await tx.apiIdempotencyExecution.update({
          where: { recordId: record.id },
          data: {
            state: 'PROCESSING',
            owner: randomUUID(),
            version: { increment: 1 },
            attempts: { increment: 1 },
            leaseExpiresAt: new Date(now.getTime() + policy.leaseMs),
            errorCode: null,
          },
        });
      }
      return {
        kind: 'acquired' as const,
        lease: {
          recordId: record.id,
          integrationClientId,
          owner: execution.owner,
          version: execution.version,
        },
        resourceId: record.resourceId,
      };
    });
  }

  private async owned(tx: Prisma.TransactionClient, lease: PrequoteLease) {
    const [record] = await tx.$queryRaw<
      { id: string; resourceId: string; requestHash: string }[]
    >`SELECT * FROM "ApiIdempotencyRecord" WHERE id=${lease.recordId}::uuid AND ${ownerSql(lease.integrationClientId)} FOR UPDATE`;
    if (!record) throw lost();
    await tx.$queryRaw`SELECT "recordId" FROM "ApiIdempotencyExecution" WHERE "recordId"=${record.id}::uuid FOR UPDATE`;
    const execution = await tx.apiIdempotencyExecution.findUnique({
      where: { recordId: record.id },
    });
    const now = await dbNow(tx);
    if (
      !execution ||
      execution.state !== 'PROCESSING' ||
      execution.owner !== lease.owner ||
      execution.version !== lease.version ||
      execution.leaseExpiresAt <= now
    )
      throw lost();
    return { record, execution, now };
  }

  async fail(lease: PrequoteLease, errorCode: string, retryable: boolean) {
    // Codes only, never external messages, request bodies or credentials.
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode))
      throw new DomainException(
        'PREQUOTE_ERROR_CODE_INVALID',
        400,
        'Invalid internal error code',
      );
    return this.prisma.$transaction(async (tx) => {
      const { execution } = await this.owned(tx, lease);
      return tx.apiIdempotencyExecution.update({
        where: { recordId: lease.recordId },
        data: {
          state:
            retryable && execution.attempts < execution.maxAttempts
              ? 'RETRYABLE_FAILED'
              : 'FAILED',
          errorCode,
        },
      });
    });
  }

  async publish(
    lease: PrequoteLease,
    input: unknown,
    evidence: { serviceZoneId: string; ratePlanId: string; route: RouteResult },
    validityMs: number,
    shippingPayer?: ShippingPayer,
  ) {
    const conditions = normalizePrequoteConditions(
      input,
      demandOwner(lease.integrationClientId).kind === 'CUSTOMER',
    );
    if (!validDuration(validityMs, 86_400_000))
      throw new DomainException(
        'PREQUOTE_DURATION_INVALID',
        400,
        'Invalid internal offer duration',
      );
    return this.prisma.$transaction(async (tx) => {
      const { record } = await this.owned(tx, lease);
      if (
        record.requestHash !==
        fingerprint(
          PREQUOTE_OPERATION,
          demandOwner(lease.integrationClientId).kind === 'CUSTOMER'
            ? { conditions, shippingPayer: shippingPayer ?? 'REQUESTER' }
            : conditions,
        )
      )
        throw conflict();
      // Lock order: key record -> zone -> plan -> bands. No external work is performed here.
      await tx.$queryRaw`SELECT id FROM "ServiceZone" WHERE id=${evidence.serviceZoneId}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM "RatePlan" WHERE id=${evidence.ratePlanId}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM "RateBand" WHERE "ratePlanId"=${evidence.ratePlanId}::uuid ORDER BY id FOR SHARE`;
      const configuration = await prepareQuotePricing(
        tx,
        conditions.stops[0],
        conditions.stops[1],
        'LOCAL_DELIVERY',
        { zones: this.zones, plans: this.plans },
      );
      if (
        configuration.zone.id !== evidence.serviceZoneId ||
        configuration.plan.id !== evidence.ratePlanId ||
        configuration.plan.currency !== 'MXN'
      )
        throw new DomainException(
          'PREQUOTE_CONFIGURATION_CHANGED',
          409,
          'Pricing configuration changed before publication',
        );
      const price = evaluateQuotePrice(configuration, evidence.route);
      const zone = await tx.serviceZone.findUniqueOrThrow({
        where: { id: configuration.zone.id },
      });
      const { now } = await this.owned(tx, lease); // Clock after all required locks; expired owner cannot publish.
      const quote = await tx.deliveryPrequote.create({
        data: {
          id: record.resourceId,
          publicId: await nextPublicId(tx, 'MPQ'),
          idempotencyRecordId: record.id,
          ...ownerFields(lease.integrationClientId),
          shippingTerms: await shippingSnapshot(
            tx,
            lease.integrationClientId,
            shippingPayer,
          ),
          conditionsVersion: 1,
          conditions,
          serviceType: 'LOCAL_DELIVERY',
          serviceZoneId: zone.id,
          zoneCode: zone.code,
          zoneName: zone.name,
          zoneBoundary: zone.boundary as Prisma.InputJsonValue,
          ratePlanId: configuration.plan.id,
          rateBandId: price.band.id,
          amount: price.amount,
          currency: price.currency,
          distanceMeters: evidence.route.distanceMeters,
          durationSeconds: evidence.route.durationSeconds,
          routingProvider: evidence.route.routingProvider,
          routeCalculatedAt: evidence.route.calculatedAt,
          issuedAt: now,
          expiresAt: new Date(now.getTime() + validityMs),
        },
      });
      await this.owned(tx, lease);
      await tx.apiIdempotencyExecution.update({
        where: { recordId: record.id },
        data: { state: 'SUCCEEDED', errorCode: null },
      });
      return quote;
    });
  }
}
