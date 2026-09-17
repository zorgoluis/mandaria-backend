import type { DispatchStatus, Prisma, ServiceType } from '@prisma/client';
import { DomainException } from '../common/domain-error.js';
import { cancelActiveAssignments } from '../delivery-assignments/delivery-assignments.service.js';

export const DISPATCH_ERRORS = {
  DISPATCH_EXPIRED: 409,
  DISPATCH_CANCELLED: 409,
  DISPATCH_ALREADY_CLAIMED: 409,
  DISPATCH_RECLAIM_NOT_ALLOWED: 409,
  DISPATCH_NOT_CLAIMED_BY_PROVIDER: 409,
  PROVIDER_NOT_ELIGIBLE: 409,
  DISPATCH_HAS_ACTIVE_ASSIGNMENT: 409,
  SERVICE_COVERAGE_EXISTS: 409,
} as const;
export type DispatchErrorCode = keyof typeof DISPATCH_ERRORS;
export const dispatchError = (code: DispatchErrorCode, message: string) =>
  new DomainException(code, DISPATCH_ERRORS[code], message);

export const DISPATCH_VIEWS = ['AVAILABLE', 'CLAIMED', 'ALL'] as const;
export type DispatchView = (typeof DISPATCH_VIEWS)[number];
export const RELEASE_REASON_MIN = 3;
export const RELEASE_REASON_MAX = 500;
export const REQUEST_CANCELLED_REASON = 'DELIVERY_REQUEST_CANCELLED';

export const dispatchExpiry = (openedAt: Date, ttlMinutes: number) =>
  new Date(openedAt.getTime() + ttlMinutes * 60_000);

/**
 * Lazy expiration: an OPEN dispatch whose window has closed (now >= expiresAt) is EXPIRED even
 * before a write persists it. A CLAIMED dispatch keeps its claim after the window: expiresAt only
 * limits claiming.
 */
export function effectiveDispatchStatus(
  dispatch: { status: DispatchStatus; expiresAt: Date },
  now = new Date(),
): DispatchStatus {
  return dispatch.status === 'OPEN' && now >= dispatch.expiresAt
    ? 'EXPIRED'
    : dispatch.status;
}

/** Why a candidate may not claim, in check order; null when the claim can proceed. */
export function claimRejection(
  dispatch: {
    status: DispatchStatus;
    expiresAt: Date;
    claimedByProviderId: string | null;
  },
  candidate: { status: 'OFFERED' | 'CLAIMED' | 'RELEASED' },
  providerId: string,
  now = new Date(),
): DispatchErrorCode | 'ALREADY_OWNER' | null {
  const status = effectiveDispatchStatus(dispatch, now);
  if (status === 'CANCELLED') return 'DISPATCH_CANCELLED';
  if (status === 'EXPIRED') return 'DISPATCH_EXPIRED';
  if (status === 'CLAIMED')
    return dispatch.claimedByProviderId === providerId
      ? 'ALREADY_OWNER'
      : 'DISPATCH_ALREADY_CLAIMED';
  if (candidate.status === 'RELEASED') return 'DISPATCH_RECLAIM_NOT_ALLOWED';
  return null;
}

/**
 * Eligibility (V1.7): provider ACTIVE and an ACTIVE ProviderServiceCoverage for the exact
 * ServiceZone and ServiceType of the accepted quote. Drivers, vehicles and availability are not
 * considered yet. Deterministic order keeps the snapshot stable.
 */
export async function eligibleProviderIds(
  tx: Prisma.TransactionClient,
  serviceZoneId: string,
  serviceType: ServiceType,
  providerId?: string,
) {
  const rows = providerId
    ? await tx.$queryRaw<
        { id: string }[]
      >`SELECT p.id FROM "DeliveryProvider" p JOIN "ProviderServiceCoverage" c ON c."providerId" = p.id WHERE p.status = 'ACTIVE' AND c.status = 'ACTIVE' AND c."serviceZoneId" = ${serviceZoneId}::uuid AND c."serviceType" = ${serviceType}::"ServiceType" AND p.id = ${providerId}::uuid`
    : await tx.$queryRaw<
        { id: string }[]
      >`SELECT p.id FROM "DeliveryProvider" p JOIN "ProviderServiceCoverage" c ON c."providerId" = p.id WHERE p.status = 'ACTIVE' AND c.status = 'ACTIVE' AND c."serviceZoneId" = ${serviceZoneId}::uuid AND c."serviceType" = ${serviceType}::"ServiceType" ORDER BY p."createdAt", p.id`;
  return rows.map((row) => row.id);
}

/**
 * Opens the dispatch of a quote that has just been ACCEPTED, inside the same transaction, and
 * snapshots its candidates. Zero candidates is valid: the dispatch stays OPEN until it expires.
 */
export async function openDispatch(
  tx: Prisma.TransactionClient,
  quote: {
    id: string;
    deliveryRequestId: string;
    serviceZoneId: string;
    serviceType: ServiceType;
  },
  ttlMinutes: number,
  now: Date,
) {
  const providerIds = await eligibleProviderIds(
    tx,
    quote.serviceZoneId,
    quote.serviceType,
  );
  const dispatch = await tx.dispatch.create({
    data: {
      deliveryRequestId: quote.deliveryRequestId,
      deliveryQuoteId: quote.id,
      openedAt: now,
      expiresAt: dispatchExpiry(now, ttlMinutes),
    },
    select: { id: true, expiresAt: true },
  });
  if (providerIds.length)
    await tx.dispatchCandidate.createMany({
      data: providerIds.map((providerId) => ({
        dispatchId: dispatch.id,
        providerId,
        offeredAt: now,
      })),
    });
  return { ...dispatch, providerIds };
}

/**
 * Called by the official DeliveryRequest cancellation, inside its transaction (request row already
 * locked). OPEN or CLAIMED dispatches stop being operational: CANCELLED (claim owner kept as
 * history), or EXPIRED when an OPEN window had already closed. V1.8: ACTIVE delivery assignments
 * of those dispatches end first as CANCELLED / DELIVERY_CANCELLED (history kept).
 */
export async function closeDispatchesForCancelledRequest(
  tx: Prisma.TransactionClient,
  deliveryRequestId: string,
  now: Date,
  actorUserId: string | null = null,
) {
  const rows = await tx.$queryRaw<
    {
      id: string;
      status: DispatchStatus;
      expiresAt: Date;
      claimedByProviderId: string | null;
    }[]
  >`SELECT id, status, "expiresAt", "claimedByProviderId" FROM "Dispatch" WHERE "deliveryRequestId" = ${deliveryRequestId}::uuid AND status IN ('OPEN', 'CLAIMED') FOR UPDATE`;
  const assignments = await cancelActiveAssignments(
    tx,
    rows.map((row) => row.id),
    now,
    actorUserId,
  );
  const events: {
    event: 'DISPATCH_CANCELLED' | 'DISPATCH_EXPIRED';
    dispatchId: string;
    providerId: string | null;
  }[] = [];
  for (const row of rows) {
    const expired = effectiveDispatchStatus(row, now) === 'EXPIRED';
    await tx.dispatch.update({
      where: { id: row.id },
      data: expired
        ? { status: 'EXPIRED', expiredAt: now }
        : {
            status: 'CANCELLED',
            cancelledAt: now,
            cancellationReason: REQUEST_CANCELLED_REASON,
          },
    });
    events.push({
      event: expired ? 'DISPATCH_EXPIRED' : 'DISPATCH_CANCELLED',
      dispatchId: row.id,
      providerId: row.claimedByProviderId,
    });
  }
  return { events, assignments };
}
