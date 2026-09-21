import type { ServiceType } from '@prisma/client';
import { DomainException } from '../common/domain-error.js';

export const INDEPENDENT_ERRORS = {
  DRIVER_NOT_ELIGIBLE: 409,
  INDEPENDENT_PROFILE_EXISTS: 409,
  INDEPENDENT_NOT_APPROVED: 409,
  INDEPENDENT_DRIVER_HAS_ACTIVE_ASSIGNMENT: 409,
  DISPATCH_EXPIRED: 409,
  DISPATCH_CANCELLED: 409,
  DISPATCH_ALREADY_CLAIMED: 409,
  DISPATCH_NOT_OPEN_TO_INDEPENDENT: 409,
  DISPATCH_RETAKE_NOT_ALLOWED: 409,
  DISPATCH_NOT_CLAIMED_BY_DRIVER: 409,
  DRIVER_BUSY: 409,
  VEHICLE_BUSY: 409,
  VEHICLE_NOT_ELIGIBLE: 409,
  VEHICLE_HAS_ACTIVE_ASSIGNMENT: 409,
  VEHICLE_LIMIT_REACHED: 409,
  TAKE_CONFLICT: 409,
} as const;
export type IndependentErrorCode = keyof typeof INDEPENDENT_ERRORS;
export const independentError = (code: IndependentErrorCode, message: string) =>
  new DomainException(code, INDEPENDENT_ERRORS[code], message);

/**
 * A PostgreSQL guard (delivery_assignment_guard, dispatch_guard) raising its RAISE EXCEPTION means
 * the row changed under us — a lost race, not an internal failure. Prisma surfaces it as P0001,
 * wrapped differently for raw queries and for the query builder, so the check is on the message.
 */
export function isGuardRejection(error: unknown) {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message: unknown }).message)
      : '';
  return (
    /P0001/.test(message) ||
    /DELIVERY_ASSIGNMENT_INVALID|DISPATCH_INVALID|DISPATCH_IMMUTABLE|INDEPENDENT_DRIVER_HAS_ACTIVE_ASSIGNMENT/.test(
      message,
    )
  );
}

/**
 * Which execution models may run each service (V1.9 §14). This is an explicit, exhaustive policy,
 * not an assumption: adding a ServiceType fails to compile until its mode is decided here, so no
 * future service becomes available to independents by default.
 *
 * LOCAL_DELIVERY is BOTH: a small parcel inside one zone is exactly what a self-employed courier
 * does, and V1.6 already prices it identically whoever carries it. A service needing fleet
 * guarantees (insured freight, multi-vehicle) would be declared FLEET here and independents would
 * never see it.
 */
export const SERVICE_EXECUTION_MODES = {
  LOCAL_DELIVERY: 'BOTH',
} as const satisfies Record<ServiceType, 'FLEET' | 'INDEPENDENT' | 'BOTH'>;

export const independentServiceTypes = Object.entries(SERVICE_EXECUTION_MODES)
  .filter(([, mode]) => mode === 'BOTH' || mode === 'INDEPENDENT')
  .map(([serviceType]) => serviceType as ServiceType);

export const allowsIndependent = (serviceType: ServiceType) =>
  independentServiceTypes.includes(serviceType);

/** Motives an independent driver may give when abandoning a service (V1.9 §37). */
export const INDEPENDENT_RELEASE_REASONS = [
  'VEHICLE_ISSUE',
  'PERSONAL_EMERGENCY',
  'CANNOT_COMPLETE',
  'OPERATIONAL_ISSUE',
  'OTHER',
] as const;
export type IndependentReleaseReason =
  (typeof INDEPENDENT_RELEASE_REASONS)[number];
export const RELEASE_DETAIL_MIN = 3;
export const RELEASE_DETAIL_MAX = 500;

/**
 * V1.9 keeps the V1.8 DeliveryAssignmentEndReason enum: the four motives above that have no exact
 * V1.8 counterpart are stored as OPERATIONAL_CHANGE (or VEHICLE_ISSUE) with the driver's motive
 * preserved verbatim in endReasonDetail, so no delivery history is lost and the enum stays shared
 * between both execution models.
 */
export const RELEASE_END_REASON = {
  VEHICLE_ISSUE: 'VEHICLE_ISSUE',
  PERSONAL_EMERGENCY: 'DRIVER_UNAVAILABLE',
  CANNOT_COMPLETE: 'DRIVER_UNAVAILABLE',
  OPERATIONAL_ISSUE: 'OPERATIONAL_CHANGE',
  OTHER: 'OTHER',
} as const satisfies Record<IndependentReleaseReason, string>;

/**
 * Why an approved independent driver may not take this dispatch, in check order; null when the
 * take can proceed. Mirrors claimRejection (V1.7) so both execution models reject for the same
 * reasons with the same codes.
 */
export type TakeRejectionCode =
  | 'DISPATCH_CANCELLED'
  | 'DISPATCH_EXPIRED'
  | 'DISPATCH_ALREADY_CLAIMED'
  | 'DISPATCH_NOT_OPEN_TO_INDEPENDENT'
  | 'DISPATCH_RETAKE_NOT_ALLOWED';
export function takeRejection(
  dispatch: {
    status: string;
    expiresAt: Date;
    serviceType: ServiceType;
  },
  alreadyReleased: boolean,
  now = new Date(),
): TakeRejectionCode | null {
  if (dispatch.status === 'CANCELLED') return 'DISPATCH_CANCELLED';
  if (dispatch.status === 'EXPIRED') return 'DISPATCH_EXPIRED';
  if (dispatch.status === 'OPEN' && now >= dispatch.expiresAt)
    return 'DISPATCH_EXPIRED';
  if (dispatch.status === 'CLAIMED') return 'DISPATCH_ALREADY_CLAIMED';
  if (!allowsIndependent(dispatch.serviceType))
    return 'DISPATCH_NOT_OPEN_TO_INDEPENDENT';
  // Parity with DISPATCH_RECLAIM_NOT_ALLOWED: whoever gave a service back cannot take it again.
  if (alreadyReleased) return 'DISPATCH_RETAKE_NOT_ALLOWED';
  return null;
}
