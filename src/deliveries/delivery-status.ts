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
      id: true,
      status: true,
      expiresAt: true,
      claimedByProviderId: true,
      claimedByIndependentDriverId: true,
      deliveredAt: true,
      cancelledAt: true,
      publicExecutionSnapshot: true,
      candidates: {
        where: { status: 'CLAIMED' },
        select: { providerId: true, provider: { select: { name: true } } },
      },
      deliveryAssignments: {
        where: { status: { in: ['ACTIVE', 'COMPLETED', 'RETURNED'] } },
        orderBy: { assignedAt: 'desc' },
        take: 1,
        select: {
          mode: true,
          custodyResolutionId: true,
          provider: { select: { name: true } },
          driver: { select: { displayName: true } },
        },
      },
    },
  },
} satisfies Prisma.DeliveryRequestSelect;

export type DeliveryStatusRecord = Prisma.DeliveryRequestGetPayload<{
  select: typeof deliveryStatusSelect;
}>;

export type PublicExecutionIdentity = {
  mode: B2bExecutionMode;
  provider: { displayName: string } | null;
  driver: { displayName: string } | null;
};

const publicName = (value: unknown): { displayName: string } | null =>
  typeof value === 'string' && value.trim() ? { displayName: value } : null;

/** Allowlist even persisted JSON: never spread historical payloads into a public response. */
function historicalIdentity(
  value: Prisma.JsonValue | undefined,
  mode: B2bExecutionMode,
): PublicExecutionIdentity {
  const record =
    value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const name = (entry: Prisma.JsonValue | undefined) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? publicName(entry.displayName)
      : null;
  return {
    mode,
    provider: mode === 'PROVIDER' ? name(record.provider) : null,
    driver: name(record.driver),
  };
}

export type DeliveryStatusView = {
  publicId: string;
  externalReference: string | null;
  status: B2bDeliveryStatus;
  execution: PublicExecutionIdentity | null;
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
  RETURNED: 'CANCELLED',
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
 * independent driver took it. V1.12-G adds explicitly public presentation names; internal IDs remain
 * outside the public contract. Delivered identities always come from the immutable snapshot.
 */
export function deliveryStatusView(
  request: DeliveryStatusRecord,
  now = new Date(),
): DeliveryStatusView {
  const dispatch = request.dispatches[0] ?? null;
  const transferred = dispatch?.deliveryAssignments?.[0]?.custodyResolutionId
    ? dispatch.deliveryAssignments[0]
    : null;
  const mode: B2bExecutionMode | null = transferred
    ? transferred.mode === 'FLEET'
      ? 'PROVIDER'
      : 'INDEPENDENT'
    : dispatch?.claimedByProviderId
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
    execution: !mode
      ? null
      : status === 'DELIVERED'
        ? historicalIdentity(dispatch?.publicExecutionSnapshot, mode)
        : status === 'ASSIGNED'
          ? {
              mode,
              provider:
                mode === 'PROVIDER'
                  ? publicName(
                      transferred
                        ? transferred.provider?.name
                        : dispatch?.candidates?.find(
                            (c) =>
                              c.providerId === dispatch.claimedByProviderId,
                          )?.provider.name,
                    )
                  : null,
              driver: publicName(
                dispatch?.deliveryAssignments?.[0]?.driver.displayName,
              ),
            }
          : status === 'CANCELLED'
            ? { mode, provider: null, driver: null }
            : null,
    requestedAt: request.requestedAt,
    // Null until the delivery is completed: never 0, never an empty string.
    deliveredAt: dispatch?.deliveredAt ?? null,
    cancelledAt:
      status === 'CANCELLED'
        ? (request.cancelledAt ?? dispatch?.cancelledAt ?? null)
        : null,
  };
}
