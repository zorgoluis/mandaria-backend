import { B2B_EVENT_TYPES } from '../b2b-events/b2b-outbox.js';

/**
 * V1.12-E: three different things, kept apart because confusing them is how operators end up
 * distrusting the data.
 *
 *   **Event state** — what happened in the world. `delivery.completed` is a fact; it has no state
 *     of its own beyond existing, and it is immutable (V1.12-B).
 *   **Transport state** — whether Mandaria has managed to hand that fact to the client. This is
 *     what moves: PENDING, DELIVERED, EXHAUSTED (V1.12-D), plus the derived NO_DELIVERY below.
 *   **Attempt history** — what happened on the wire each time it was tried. Immutable (V1.12-C).
 *
 * An administrative screen that mixes them will say things like "the event failed", which is not a
 * thing that can happen.
 */

/**
 * The transport state as an operator should read it, including the case that is not persisted.
 *
 * `NO_DELIVERY` is **derived, never stored**: an event with no `B2bWebhookDelivery` row is not
 * broken and not lost, it is simply outside reliable delivery — recorded before V1.12-C existed,
 * or before the endpoint's `deliverFrom` boundary, or belonging to a client that has no webhook.
 * Inventing a persisted state for it would have meant writing rows for history that never asked
 * for any.
 */
export const TRANSPORT_STATES = [
  'PENDING',
  'DELIVERED',
  'EXHAUSTED',
  'NO_DELIVERY',
] as const;
export type TransportState = (typeof TRANSPORT_STATES)[number];

/** Why an event is outside reliable delivery, when it is. Nothing here is a fault. */
export const NO_DELIVERY_REASONS = [
  'NO_ENDPOINT',
  'BEFORE_BOUNDARY',
  'NOT_YET_PICKED_UP',
] as const;
export type NoDeliveryReason = (typeof NO_DELIVERY_REASONS)[number];

export type DeliveryRow = {
  state: 'PENDING' | 'DELIVERED' | 'EXHAUSTED';
  attemptCount: number;
  nextAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  deliveredAt: Date | null;
  exhaustedAt: Date | null;
  leaseExpiresAt: Date | null;
} | null;

export type EndpointRow = {
  enabled: boolean;
  deliverFrom: Date;
  secretCiphertext: string | null;
} | null;

/**
 * Reads the transport situation of one event. When there is no state row, it says why in terms an
 * operator can act on: no webhook configured, older than the boundary, or eligible but not picked
 * up yet — that last one is a normal few seconds, not an incident.
 */
export function transportOf(
  event: { occurredAt: Date },
  delivery: DeliveryRow,
  endpoint: EndpointRow,
  now = new Date(),
): {
  state: TransportState;
  reason: NoDeliveryReason | null;
  attemptCount: number;
  nextAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  deliveredAt: Date | null;
  exhaustedAt: Date | null;
  /** True while a worker holds it right now, which is why nothing seems to be happening. */
  inFlight: boolean;
} {
  if (delivery)
    return {
      state: delivery.state,
      reason: null,
      attemptCount: delivery.attemptCount,
      nextAttemptAt: delivery.nextAttemptAt,
      lastAttemptAt: delivery.lastAttemptAt,
      deliveredAt: delivery.deliveredAt,
      exhaustedAt: delivery.exhaustedAt,
      inFlight: !!delivery.leaseExpiresAt && delivery.leaseExpiresAt > now,
    };
  const reason: NoDeliveryReason =
    !endpoint || !endpoint.secretCiphertext
      ? 'NO_ENDPOINT'
      : event.occurredAt < endpoint.deliverFrom
        ? 'BEFORE_BOUNDARY'
        : 'NOT_YET_PICKED_UP';
  return {
    state: 'NO_DELIVERY',
    reason,
    attemptCount: 0,
    nextAttemptAt: null,
    lastAttemptAt: null,
    deliveredAt: null,
    exhaustedAt: null,
    inFlight: false,
  };
}

/** The public name of an event type, never the internal enum, even for an administrator. */
export const publicType = (type: keyof typeof B2B_EVENT_TYPES) =>
  B2B_EVENT_TYPES[type];

/**
 * What a manual request actually did, in the operator's vocabulary rather than the engine's. A
 * screen must never say "delivered" when all that happened was that work was queued.
 */
export const REDELIVERY_OUTCOMES = [
  'DELIVERED',
  'FAILED',
  'RESCHEDULED',
  'EXHAUSTED',
  'SKIPPED',
] as const;
export type RedeliveryOutcome = (typeof REDELIVERY_OUTCOMES)[number];

export function redeliveryOutcome(result: {
  kind: 'attempted' | 'skipped';
  outcomeResult?: 'SUCCEEDED' | 'FAILED';
  state?: string;
}): RedeliveryOutcome {
  if (result.kind === 'skipped') return 'SKIPPED';
  if (result.outcomeResult === 'SUCCEEDED') return 'DELIVERED';
  // It failed on the wire; what matters operationally is whether anything will happen next.
  if (result.state === 'PENDING') return 'RESCHEDULED';
  if (result.state === 'EXHAUSTED') return 'EXHAUSTED';
  return 'FAILED';
}
