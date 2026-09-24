import type { Prisma } from '@prisma/client';
import {
  deliveryStatusSelect,
  deliveryStatusView,
  type DeliveryStatusView,
} from '../deliveries/delivery-status.js';

/**
 * V1.12-B: the first durable B2B event of Mandaria.
 *
 * V1.12-A let a client ask whether its delivery was done; V1.12-B records the answer as a fact, in
 * the same transaction that produces it. This version only *records*. There is no HTTP delivery, no
 * worker, no retry and no signature, so there is deliberately no transport state either: the row
 * existing is the whole meaning of the event.
 */

/** Wire name of the event type, in one place. The column keeps a controlled enum; this is what a
 * consumer will eventually read in `type`, and the two must never be spelled independently. */
export const B2B_EVENT_TYPES = {
  DELIVERY_COMPLETED: 'delivery.completed',
} as const;
export type B2bEventTypeName =
  (typeof B2B_EVENT_TYPES)[keyof typeof B2B_EVENT_TYPES];

/** Structured log line, following the existing convention. */
export const B2B_EVENT_RECORDED = 'B2B_EVENT_RECORDED';

/**
 * The event as a consumer will see it. The envelope lives in columns and the snapshot in `payload`,
 * so there is exactly one representation of each part; this type is what puts them back together.
 */
export type B2bEvent = {
  eventId: string;
  type: B2bEventTypeName;
  occurredAt: Date;
  data: DeliveryStatusView;
};

/** Everything the event needs about the delivery, read through the V1.12-A selection so there is
 * no second idea of what the public model is made of. */
const subjectSelect = {
  ...deliveryStatusSelect,
  id: true,
  integrationClientId: true,
} as const;

/**
 * Records `delivery.completed` for a dispatch that has just been delivered, inside the caller's
 * transaction.
 *
 * The payload is built by `deliveryStatusView`, the same and only mapping the B2B status endpoint
 * uses, reading the rows this transaction has already written: the snapshot is therefore exactly
 * what `GET /delivery-requests/{publicId}/status` answers at this instant, with no second mapping
 * to drift. It is frozen on purpose — a webhook sent tomorrow must carry what was true today, not
 * a fresh read of tables that may have moved on.
 *
 * `occurredAt` is the `deliveredAt` of the completion itself, passed in rather than read from a
 * clock again, so the event cannot be milliseconds away from the fact it describes. PostgreSQL
 * re-checks that equality, that the dispatch really is DELIVERED in this same transaction, and that
 * the owner is the client that owns the request.
 *
 * Nothing economic or geographic happens here: no credits move, no policy is consulted, no snapshot
 * is recalculated and no route is requested.
 */
export async function recordDeliveryCompleted(
  tx: Prisma.TransactionClient,
  dispatchId: string,
  deliveryRequestId: string,
  occurredAt: Date,
): Promise<B2bEvent> {
  const request = await tx.deliveryRequest.findUniqueOrThrow({
    where: { id: deliveryRequestId },
    select: subjectSelect,
  });
  const data = deliveryStatusView(request, occurredAt);
  const event = await tx.b2bOutboxEvent.create({
    data: {
      type: 'DELIVERY_COMPLETED',
      integrationClientId: request.integrationClientId,
      deliveryRequestId,
      dispatchId,
      occurredAt,
      payload: b2bEventPayload(data),
    },
    select: { id: true },
  });
  return {
    eventId: event.id,
    type: B2B_EVENT_TYPES.DELIVERY_COMPLETED,
    occurredAt,
    data,
  };
}

/**
 * What an operator needs to follow an event: which event, of what type, about which delivery. The
 * payload is deliberately left out — it is already durable in the row, it can only grow, and it
 * carries the client's own `externalReference`, which does not belong in application logs.
 */
export const recordedEventLog = (event: B2bEvent) => ({
  event: B2B_EVENT_RECORDED,
  eventId: event.eventId,
  type: event.type,
  publicId: event.data.publicId,
  occurredAt: event.occurredAt.toISOString(),
});

/**
 * The public model as it is persisted and as it will travel: the same fields the HTTP endpoint
 * returns, with dates rendered the way JSON renders them. This is serialization of the canonical
 * model, not a second mapping — `deliveryStatusView` remains the only place that decides what the
 * public state of a delivery is.
 */
export function b2bEventPayload(data: DeliveryStatusView) {
  return {
    publicId: data.publicId,
    externalReference: data.externalReference,
    status: data.status,
    execution: data.execution,
    requestedAt: data.requestedAt.toISOString(),
    deliveredAt: data.deliveredAt ? data.deliveredAt.toISOString() : null,
    cancelledAt: data.cancelledAt ? data.cancelledAt.toISOString() : null,
  };
}
