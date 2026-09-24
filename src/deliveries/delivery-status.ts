import type { Prisma } from '@prisma/client';
import { effectiveDispatchStatus } from '../dispatch/dispatch-policy.js';

/**
 * V1.12-A: the logistics status a B2B client sees for its own DeliveryRequest.
 *
 * This is a public contract, deliberately smaller and more stable than the internal model: a
 * client integrates against these six outcomes, not against Dispatch, DispatchCandidate or
 * DeliveryAssignment. Internal states can be added or split later without breaking anyone, as long
 * as they map into one of these.
 *
 *   REQUESTED  the request exists and no service has been published yet (no accepted quote)
 *   OPEN       published and waiting for someone to take it (with or without candidates)
 *   ASSIGNED   a provider or an independent driver is executing it
 *   DELIVERED  the delivery was completed (V1.11)
 *   CANCELLED  cancelled before being delivered
 *   EXPIRED    nobody took it inside its window, or it was given back after the window closed
 *
 * EXPIRED is kept apart from CANCELLED on purpose: "nobody took it" and "you cancelled it" are
 * different answers for whoever integrates, and the difference already exists in the domain.
 */
export const B2B_DELIVERY_STATUSES = [
  'REQUESTED',
  'OPEN',
  'ASSIGNED',
  'DELIVERED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type B2bDeliveryStatus = (typeof B2B_DELIVERY_STATUSES)[number];

/** Who is executing the service, in the same vocabulary the credit domain already uses. */
export const B2B_EXECUTION_MODES = ['PROVIDER', 'INDEPENDENT'] as const;
export type B2bExecutionMode = (typeof B2B_EXECUTION_MODES)[number];

/**
 * Exactly what the status needs: the request's own outcome plus its single dispatch. A request has
 * at most one Dispatch (one ACCEPTED quote per request by partial unique index, and one Dispatch
 * per quote), and the query is still ordered and limited so the read can never depend on the
 * incidental order of a relation.
 */
export const deliveryStatusSelect = {
  publicId: true,
  externalReference: true,
  status: true,
  requestedAt: true,
  cancelledAt: true,
  dispatches: {
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: {
      status: true,
      expiresAt: true,
      claimedByProviderId: true,
      claimedByIndependentDriverId: true,
      deliveredAt: true,
      cancelledAt: true,
    },
  },
} as const;

export type DeliveryStatusRecord = Prisma.DeliveryRequestGetPayload<{
  select: typeof deliveryStatusSelect;
}>;

export type DeliveryStatusView = {
  publicId: string;
  externalReference: string | null;
  status: B2bDeliveryStatus;
  execution: { mode: B2bExecutionMode } | null;
  requestedAt: Date;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
};

/** Internal dispatch state (already resolved for the lazy expiry of V1.7) → public state. */
const DISPATCH_STATUS: Record<string, B2bDeliveryStatus> = {
  OPEN: 'OPEN',
  CLAIMED: 'ASSIGNED',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
};

/**
 * The single place where internal logistics becomes the public status. Controllers never map
 * states themselves, and V1.12-B/C can reuse this same view for a webhook payload.
 *
 * A request without a dispatch is REQUESTED (or CANCELLED if the client cancelled it before any
 * service was published). With a dispatch, the dispatch decides, because it is what actually
 * happened operationally: a delivery that was completed stays DELIVERED even if the request was
 * cancelled afterwards, and an OPEN dispatch whose window has closed reads as EXPIRED, the same
 * effective status V1.7 reports everywhere else.
 *
 * ASSIGNED means "somebody is executing this service", whether a provider claimed it or an
 * independent driver took it. Which driver or vehicle is doing it is an internal matter and is
 * deliberately not part of the public contract.
 */
export function deliveryStatusView(
  request: DeliveryStatusRecord,
  now = new Date(),
): DeliveryStatusView {
  const dispatch = request.dispatches[0] ?? null;
  const mode: B2bExecutionMode | null = dispatch?.claimedByProviderId
    ? 'PROVIDER'
    : dispatch?.claimedByIndependentDriverId
      ? 'INDEPENDENT'
      : null;
  const status: B2bDeliveryStatus = dispatch
    ? DISPATCH_STATUS[effectiveDispatchStatus(dispatch, now)]
    : request.status === 'CANCELLED'
      ? 'CANCELLED'
      : 'REQUESTED';
  return {
    publicId: request.publicId,
    externalReference: request.externalReference,
    status,
    execution: mode ? { mode } : null,
    requestedAt: request.requestedAt,
    // Null until the delivery is completed: never 0, never an empty string.
    deliveredAt: dispatch?.deliveredAt ?? null,
    cancelledAt:
      status === 'CANCELLED'
        ? (request.cancelledAt ?? dispatch?.cancelledAt ?? null)
        : null,
  };
}
