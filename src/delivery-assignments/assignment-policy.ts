import type { ConfigService } from '@nestjs/config';
import type {
  DeliveryAssignmentEndReason,
  GoodsPaymentMode,
  Prisma,
  ServiceType,
} from '@prisma/client';
import { DomainException } from '../common/domain-error.js';

export const ASSIGNMENT_ERRORS = {
  DISPATCH_NOT_CLAIMED_BY_PROVIDER: 409,
  DISPATCH_ALREADY_ASSIGNED: 409,
  NO_ACTIVE_ASSIGNMENT: 409,
  ASSIGNMENT_UNCHANGED: 409,
  PROVIDER_NOT_ACTIVE: 409,
  DRIVER_NOT_ELIGIBLE: 409,
  VEHICLE_NOT_ELIGIBLE: 409,
  DRIVER_BUSY: 409,
  VEHICLE_BUSY: 409,
  DRIVER_VEHICLE_MISMATCH: 409,
  DISPATCH_HAS_ACTIVE_ASSIGNMENT: 409,
  ASSIGNMENT_CONFLICT: 409,
} as const;
export type AssignmentErrorCode = keyof typeof ASSIGNMENT_ERRORS;
export const assignmentError = (code: AssignmentErrorCode, message: string) =>
  new DomainException(code, ASSIGNMENT_ERRORS[code], message);

/** Reasons a provider may give; DELIVERY_CANCELLED is reserved for the official cancellation. */
export const PROVIDER_END_REASONS = [
  'DRIVER_UNAVAILABLE',
  'VEHICLE_ISSUE',
  'OPERATIONAL_CHANGE',
  'OTHER',
] as const satisfies readonly DeliveryAssignmentEndReason[];
export type ProviderEndReason = (typeof PROVIDER_END_REASONS)[number];
export const REASON_DETAIL_MIN = 3;
export const REASON_DETAIL_MAX = 500;

/**
 * Assignment deadline per ServiceType: how long the claim owner has to assign a driver and vehicle
 * after claiming. Independent from Dispatch.expiresAt (which limits claiming). New service types add
 * their own variable here.
 */
const ASSIGNMENT_TTL_VARIABLE: Record<ServiceType, string> = {
  LOCAL_DELIVERY: 'LOCAL_DELIVERY_ASSIGNMENT_TTL_MINUTES',
};
export const assignmentTtlMinutes = (
  config: ConfigService,
  serviceType: ServiceType,
) => config.getOrThrow<number>(ASSIGNMENT_TTL_VARIABLE[serviceType]);

/**
 * Derived operational signal, never persisted and without automatic release in V1.8: a CLAIMED
 * dispatch whose owner has not assigned resources after claimedAt + TTL is overdue.
 */
export function assignmentDeadline(
  dispatch: { status: string; claimedAt: Date | null },
  hasActiveAssignment: boolean,
  ttlMinutes: number,
  now = new Date(),
) {
  if (dispatch.status !== 'CLAIMED' || !dispatch.claimedAt)
    return { assignmentDeadline: null, assignmentOverdue: false };
  const deadline = new Date(dispatch.claimedAt.getTime() + ttlMinutes * 60_000);
  return {
    assignmentDeadline: deadline,
    assignmentOverdue: !hasActiveAssignment && now > deadline,
  };
}

/**
 * What the service implies in money for the provider, from V1.5 data. deliveryFee (logistic
 * price) and goodsValue (merchandise) are never mixed. With COURIER_ADVANCE the driver pays the
 * merchant goodsValue at pickup and recovers it on delivery; Mandaria neither moves that money nor
 * checks whether the driver has it — the provider is responsible.
 */
export function paymentContext(
  quote: { amount: Prisma.Decimal; currency: string },
  financial: {
    goodsValue: Prisma.Decimal | null;
    goodsPaymentMode: GoodsPaymentMode;
    currency: string;
  } | null,
) {
  const advances = financial?.goodsPaymentMode === 'COURIER_ADVANCE';
  return {
    deliveryFee: { amount: quote.amount.toFixed(2), currency: quote.currency },
    goodsValue:
      financial?.goodsValue != null
        ? {
            amount: financial.goodsValue.toFixed(2),
            currency: financial.currency,
          }
        : null,
    goodsPaymentMode: financial?.goodsPaymentMode ?? null,
    driverAdvancesGoods: advances,
    driverAdvanceAmount:
      advances && financial?.goodsValue != null
        ? {
            amount: financial.goodsValue.toFixed(2),
            currency: financial.currency,
          }
        : null,
  };
}

/** V1.4 driver ↔ vehicle pairing must not contradict the assignment (see README V1.8). */
export function pairingConflict(
  pairings: { driverId: string; vehicleId: string }[],
  driverId: string,
  vehicleId: string,
) {
  return pairings.some(
    (p) =>
      (p.driverId === driverId && p.vehicleId !== vehicleId) ||
      (p.vehicleId === vehicleId && p.driverId !== driverId),
  );
}
