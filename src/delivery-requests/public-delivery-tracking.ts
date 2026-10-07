import { shippingView } from '../customers/shipping-view.js';
import { ownerFields } from '../customers/demand-owner.js';
import type { DemandOwnerInput } from '../customers/demand-owner.js';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  deliveryStatusSelect,
  deliveryStatusView,
} from '../deliveries/delivery-status.js';

/** Internal materialization only: no logistics command, webhook or financial effect. */
export async function publicDeliveryStatus(
  db: PrismaClient,
  publicId: string,
  integrationClientId: DemandOwnerInput,
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await db.$transaction(
        async (tx) => {
          return publicDeliveryStatusTx(tx, publicId, integrationClientId);
        },
        { isolationLevel: 'RepeatableRead', timeout: 15000 },
      );
    } catch (error) {
      // A concurrent invalidation/publication cannot overwrite a newer snapshot.
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        !(
          error.code === 'P2034' ||
          (error.code === 'P2010' &&
            ['40001', '40P01'].includes(String(error.meta?.code)))
        )
      )
        throw error;
    }
  }
  throw new ServiceUnavailableException('Tracking temporarily unavailable');
}

export async function publicDeliveryStatusTx(
  tx: Prisma.TransactionClient,
  publicId: string,
  integrationClientId: DemandOwnerInput,
): Promise<Record<string, unknown> & { publicVersion: string }> {
  const request = await tx.deliveryRequest.findFirst({
    where: { publicId, ...ownerFields(integrationClientId) },
    select: { ...deliveryStatusSelect, id: true },
  });
  if (!request) throw new NotFoundException('Delivery request not found');
  const [tracking] = await tx.$queryRaw<
    {
      version: bigint;
      snapshot: Prisma.JsonValue | null;
      expiryObserved: boolean;
    }[]
  >`
          SELECT version,snapshot,"expiryObserved" FROM "PublicDeliveryTracking" WHERE "deliveryRequestId"=${request.id}::uuid`;
  if (!tracking) throw new ServiceUnavailableException('Tracking unavailable');
  const dispatch = request.dispatches[0];
  // Once published, time-based expiry cannot regress when a machine clock moves backwards.
  const now =
    dispatch && tracking.expiryObserved
      ? new Date(Math.max(Date.now(), dispatch.expiresAt.getTime()))
      : new Date();
  const base = deliveryStatusView(request, now);
  const assignments = dispatch
    ? await tx.deliveryAssignment.findMany({
        where: { dispatchId: dispatch.id },
        select: { status: true },
      })
    : [];
  const [execution] = dispatch
    ? await tx.$queryRaw<
        {
          phase: number;
          revision: number;
          recordedAt: Date;
          attentionRequired: boolean;
        }[]
      >`
          SELECT e.phase,e.revision,e."recordedAt",EXISTS(SELECT 1 FROM "DeliveryCustodyIncident" i WHERE i."dispatchId"=e."dispatchId" AND i."resolvedAt" IS NULL) AS "attentionRequired"
          FROM "DeliveryExecution" e WHERE e."dispatchId"=${dispatch.id}::uuid`
    : [];
  const [returned] = execution
    ? await tx.$queryRaw<{ occurredAt: Date }[]>`
          SELECT "occurredAt" FROM "DeliveryCustodyResolution" WHERE "dispatchId"=${dispatch!.id}::uuid AND type='RETURN_TO_ORIGIN'`
    : [];
  const result = {
    ...base,
    shippingPayment: await shippingView(
      tx,
      request.id,
      ['DELIVERED', 'CANCELLED', 'EXPIRED'].includes(base.status) ||
        dispatch?.status === 'RETURNED',
    ),
    // Preserve legacy omission and old field meanings. New fields are always present.
    ...(execution
      ? {
          executionProgress:
            base.status === 'ASSIGNED'
              ? {
                  phase: [
                    null,
                    'TO_PICKUP',
                    'AT_PICKUP',
                    'PICKED_UP',
                    'TO_DROPOFF',
                    'AT_DROPOFF',
                  ][execution.phase],
                  revision: execution.revision,
                  registeredAt: execution.recordedAt,
                  attentionRequired: execution.attentionRequired,
                }
              : null,
          executionOutcome: returned
            ? {
                type: 'RETURNED_TO_ORIGIN',
                occurredAt: returned.occurredAt,
              }
            : null,
        }
      : {}),
    trackingMode: execution ? 'DETAILED' : assignments.length ? 'LEGACY' : null,
    assignmentState:
      assignments.some((a) => a.status === 'ACTIVE') &&
      base.status === 'ASSIGNED'
        ? 'ACTIVE'
        : assignments.length
          ? 'ENDED'
          : 'NONE',
    terminalOutcome: returned
      ? { type: 'RETURNED_TO_ORIGIN', occurredAt: returned.occurredAt }
      : base.status === 'DELIVERED'
        ? { type: 'DELIVERED', occurredAt: base.deliveredAt }
        : base.status === 'CANCELLED'
          ? { type: 'CANCELLED', occurredAt: base.cancelledAt }
          : base.status === 'EXPIRED'
            ? { type: 'EXPIRED', occurredAt: dispatch!.expiresAt }
            : null,
  };
  const payload = JSON.stringify(result);
  // PostgreSQL JSONB comparison ignores key order. Version is a decimal string on the wire.
  // Invalidation clears snapshot and increments version in the writer's transaction.
  // A change caused solely by expiry also advances the version before publication.
  const [same] = await tx.$queryRaw<
    { equal: boolean }[]
  >`SELECT snapshot = ${payload}::jsonb AS equal FROM "PublicDeliveryTracking" WHERE "deliveryRequestId"=${request.id}::uuid`;
  if (same?.equal)
    return {
      ...(tracking.snapshot as Record<string, unknown>),
      publicVersion: tracking.version.toString(),
    };
  const [published] = await tx.$queryRaw<
    { version: bigint; snapshot: Record<string, unknown> }[]
  >`
          UPDATE "PublicDeliveryTracking" SET
            version=version+CASE WHEN snapshot IS NOT NULL AND snapshot IS DISTINCT FROM ${payload}::jsonb THEN 1 ELSE 0 END,
            snapshot=${payload}::jsonb,
            "expiryObserved"="expiryObserved" OR ${base.status === 'EXPIRED'}
          WHERE "deliveryRequestId"=${request.id}::uuid
          RETURNING version,snapshot`;
  return {
    ...published.snapshot,
    publicVersion: published.version.toString(),
  };
}
