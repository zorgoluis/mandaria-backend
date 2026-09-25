import type {
  CreditAccountOwnerType,
  CreditCalculationType,
  ServiceType,
} from '@prisma/client';
import { DomainException } from '../common/domain-error.js';
import { MAX_CREDIT_MOVEMENT } from '../credits/credit-policy.js';

/**
 * V1.10-B credit policy engine: pure and deterministic. Given one policy version and the canonical
 * distance Mandaria already computed for the service (never a new routing call), it returns how
 * many whole credits it costs to be awarded that service. It reads no clock, no balance, no
 * provider or driver, and does no I/O. Nothing here consumes credits: charging starts in V1.10-D.
 *
 * Every credit value is a whole number bounded by the V1.10-A movement limit, because a service
 * award will be exactly one ledger movement. All arithmetic is on integers (no floating point).
 * Mirrored by the CHECKs and triggers of migration 20260922001300_credit_policies.
 */
export const MAX_POLICY_CREDITS = MAX_CREDIT_MOVEMENT;
/** Canonical distances are stored as INTEGER meters. */
export const MAX_DISTANCE_METERS = 2_147_483_647;
/** Enough for any sensible tariff table; bounds request size and range evaluation. */
export const MAX_POLICY_RANGES = 50;
export const POLICY_REASON_MIN = 3;
export const POLICY_REASON_MAX = 500;

export const CREDIT_POLICY_ERRORS = {
  CREDIT_POLICY_UNAVAILABLE: 409,
  CREDIT_POLICY_EXISTS: 409,
  CREDIT_POLICY_VERSION_CONFLICT: 409,
  CREDIT_COST_OUT_OF_RANGE: 422,
  CREDIT_DISTANCE_INVALID: 422,
} as const;
export type CreditPolicyErrorCode = keyof typeof CREDIT_POLICY_ERRORS;
export const creditPolicyError = (
  code: CreditPolicyErrorCode,
  message: string,
) => new DomainException(code, CREDIT_POLICY_ERRORS[code], message);

/**
 * DISTANCE_RANGE semantics, identical to V1.6 rate bands: each range covers
 * [minDistanceMeters, maxDistanceMeters) — min inclusive, max exclusive — in integer meters, and a
 * null max means "and beyond". A valid policy starts at 0, its ranges are contiguous and only the
 * last one is open, so every distance >= 0 matches exactly one range.
 */
export type RangeInput = {
  minDistanceMeters: number;
  maxDistanceMeters: number | null;
  credits: number;
};
export type PolicyConfig = {
  calculationType: CreditCalculationType;
  creditsPerKm?: number | null;
  minimumCredits?: number | null;
  flatCredits?: number | null;
  ranges?: RangeInput[] | null;
};
export type PolicyForCalculation = {
  id: string;
  version: number;
  serviceType: ServiceType;
  actorType: CreditAccountOwnerType;
  calculationType: CreditCalculationType;
  creditsPerKm: number | null;
  minimumCredits: number | null;
  flatCredits: number | null;
  ranges: (RangeInput & { position: number })[];
};

const isCredits = (v: unknown, min: number) =>
  Number.isSafeInteger(v) &&
  (v as number) >= min &&
  (v as number) <= MAX_POLICY_CREDITS;
const present = (v: unknown) => v !== undefined && v !== null;

/**
 * Validates a policy configuration exactly as the database will: only the fields of its
 * calculation type may be sent, and a field of another type is rejected, never ignored.
 * Returns the ranges normalized (sorted, with positions 1..n) for DISTANCE_RANGE.
 */
export function validatePolicyConfig(config: PolicyConfig) {
  const errors: string[] = [];
  const { calculationType: type } = config;
  const hasRanges =
    present(config.ranges) && (config.ranges as RangeInput[]).length > 0;
  const reject = (field: string) =>
    errors.push(`${field} is not allowed for calculationType ${type}`);
  if (type === 'PER_KM') {
    if (!isCredits(config.creditsPerKm, 1))
      errors.push(
        `creditsPerKm must be an integer between 1 and ${MAX_POLICY_CREDITS}`,
      );
    if (!isCredits(config.minimumCredits, 0))
      errors.push(
        `minimumCredits must be an integer between 0 and ${MAX_POLICY_CREDITS}`,
      );
    if (present(config.flatCredits)) reject('flatCredits');
    if (hasRanges) reject('ranges');
  } else if (type === 'FLAT') {
    if (!isCredits(config.flatCredits, 1))
      errors.push(
        `flatCredits must be an integer between 1 and ${MAX_POLICY_CREDITS}`,
      );
    if (present(config.creditsPerKm)) reject('creditsPerKm');
    if (present(config.minimumCredits)) reject('minimumCredits');
    if (hasRanges) reject('ranges');
  } else if (type === 'DISTANCE_RANGE') {
    if (present(config.creditsPerKm)) reject('creditsPerKm');
    if (present(config.minimumCredits)) reject('minimumCredits');
    if (present(config.flatCredits)) reject('flatCredits');
    if (!hasRanges) errors.push('DISTANCE_RANGE requires at least one range');
  } else errors.push('calculationType must be PER_KM, FLAT or DISTANCE_RANGE');
  const ranges =
    type === 'DISTANCE_RANGE' && hasRanges
      ? validateRanges(config.ranges as RangeInput[], errors)
      : [];
  return { valid: errors.length === 0, errors, ranges };
}

function validateRanges(input: RangeInput[], errors: string[]) {
  if (input.length > MAX_POLICY_RANGES)
    errors.push(`a policy has at most ${MAX_POLICY_RANGES} ranges`);
  const label = (r: RangeInput) =>
    `range[${r.minDistanceMeters}, ${r.maxDistanceMeters ?? '∞'})`;
  const sorted = [...input].sort(
    (a, b) => a.minDistanceMeters - b.minDistanceMeters,
  );
  sorted.forEach((r, i) => {
    const last = i === sorted.length - 1;
    if (
      !Number.isSafeInteger(r.minDistanceMeters) ||
      r.minDistanceMeters < 0 ||
      r.minDistanceMeters > MAX_DISTANCE_METERS
    )
      errors.push(
        `${label(r)}: minDistanceMeters must be an integer between 0 and ${MAX_DISTANCE_METERS}`,
      );
    if (r.maxDistanceMeters !== null) {
      if (
        !Number.isSafeInteger(r.maxDistanceMeters) ||
        r.maxDistanceMeters > MAX_DISTANCE_METERS
      )
        errors.push(
          `${label(r)}: maxDistanceMeters must be an integer up to ${MAX_DISTANCE_METERS} or null`,
        );
      else if (r.maxDistanceMeters <= r.minDistanceMeters)
        errors.push(
          `${label(r)}: maxDistanceMeters must be greater than minDistanceMeters`,
        );
    }
    if (!isCredits(r.credits, 1))
      errors.push(
        `${label(r)}: credits must be an integer between 1 and ${MAX_POLICY_CREDITS}`,
      );
    if (i === 0 && r.minDistanceMeters !== 0)
      errors.push(`${label(r)}: the first range must start at 0`);
    if (last && r.maxDistanceMeters !== null)
      errors.push(
        `${label(r)}: the last range must be open-ended (maxDistanceMeters null)`,
      );
    if (!last && r.maxDistanceMeters === null)
      errors.push(`${label(r)}: only the last range may be open-ended`);
    if (i > 0) {
      const previous = sorted[i - 1];
      if (previous.maxDistanceMeters !== null) {
        if (r.minDistanceMeters > previous.maxDistanceMeters)
          errors.push(
            `gap between ${previous.maxDistanceMeters} and ${r.minDistanceMeters} meters`,
          );
        else if (r.minDistanceMeters < previous.maxDistanceMeters)
          errors.push(`overlap between ${label(previous)} and ${label(r)}`);
      }
      if (r.minDistanceMeters === previous.minDistanceMeters)
        errors.push(`two ranges start at ${r.minDistanceMeters} meters`);
    }
  });
  return sorted.map((r, i) => ({ ...r, position: i + 1 }));
}

/** ceil(distanceMeters / 1000) with integer arithmetic only: 0 -> 0, 1..1000 -> 1, 6240 -> 7. */
export function billableKilometers(distanceMeters: number) {
  const remainder = distanceMeters % 1000;
  return (distanceMeters - remainder) / 1000 + (remainder === 0 ? 0 : 1);
}

/** "6.240" for 6240 m: an exact decimal rendering for display, never used in the calculation. */
export function formatKilometers(distanceMeters: number) {
  const whole = Math.trunc(distanceMeters / 1000);
  return `${whole}.${String(distanceMeters - whole * 1000).padStart(3, '0')}`;
}

/** The canonical distance must be whole, non-negative INTEGER meters; anything else fails closed. */
export function assertCanonicalDistance(
  distanceMeters: unknown,
): asserts distanceMeters is number {
  if (
    typeof distanceMeters !== 'number' ||
    !Number.isSafeInteger(distanceMeters) ||
    distanceMeters < 0 ||
    distanceMeters > MAX_DISTANCE_METERS
  )
    throw creditPolicyError(
      'CREDIT_DISTANCE_INVALID',
      `distanceMeters must be an integer between 0 and ${MAX_DISTANCE_METERS}`,
    );
}

/** Returns the range whose [min, max) contains the distance (max null = unbounded). */
export function findRange<T extends RangeInput>(
  ranges: T[],
  distanceMeters: number,
) {
  const matches = ranges.filter(
    (r) =>
      distanceMeters >= r.minDistanceMeters &&
      (r.maxDistanceMeters === null || distanceMeters < r.maxDistanceMeters),
  );
  // A valid policy always yields exactly one; zero or several means corrupt configuration.
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The credit cost of being awarded a service under one policy version. Same policy version and
 * same distance always give the same result.
 *   PER_KM:          max(ceil(distanceMeters / 1000) * creditsPerKm, minimumCredits)
 *   FLAT:            flatCredits, whatever the distance
 *   DISTANCE_RANGE:  credits of the single range containing the distance
 * A result above the movement limit is refused (CREDIT_COST_OUT_OF_RANGE), never truncated.
 */
export function calculateCreditCost(input: {
  policy: PolicyForCalculation;
  distanceMeters: number;
}) {
  const { policy, distanceMeters } = input;
  assertCanonicalDistance(distanceMeters);
  const base = {
    policyId: policy.id,
    policyVersion: policy.version,
    serviceType: policy.serviceType,
    actorType: policy.actorType,
    calculationType: policy.calculationType,
    distanceMeters,
    distanceKm: formatKilometers(distanceMeters),
  };
  const corrupt = () =>
    creditPolicyError(
      'CREDIT_POLICY_UNAVAILABLE',
      `Credit policy ${policy.id} v${policy.version} has an invalid configuration`,
    );
  const bounded = (credits: number) => {
    if (!Number.isSafeInteger(credits) || credits > MAX_POLICY_CREDITS)
      throw creditPolicyError(
        'CREDIT_COST_OUT_OF_RANGE',
        `The credit cost exceeds the maximum of ${MAX_POLICY_CREDITS} credits per service`,
      );
    return credits;
  };
  if (policy.calculationType === 'PER_KM') {
    if (
      !isCredits(policy.creditsPerKm, 1) ||
      !isCredits(policy.minimumCredits, 0)
    )
      throw corrupt();
    const billableKm = billableKilometers(distanceMeters);
    // At most ~2.1e6 km * 1e6 credits/km ~ 2.1e12, well inside the safe integer range.
    const calculatedCredits = billableKm * (policy.creditsPerKm as number);
    const minimumCredits = policy.minimumCredits as number;
    return {
      ...base,
      billableKm,
      calculatedCredits,
      minimumCredits,
      minimumApplied: calculatedCredits < minimumCredits,
      rangePosition: null,
      credits: bounded(Math.max(calculatedCredits, minimumCredits)),
    };
  }
  if (policy.calculationType === 'FLAT') {
    if (!isCredits(policy.flatCredits, 1)) throw corrupt();
    return {
      ...base,
      billableKm: null,
      calculatedCredits: null,
      minimumCredits: null,
      minimumApplied: false,
      rangePosition: null,
      credits: bounded(policy.flatCredits as number),
    };
  }
  const range = findRange(policy.ranges, distanceMeters);
  if (!range || !isCredits(range.credits, 1)) throw corrupt();
  return {
    ...base,
    billableKm: null,
    calculatedCredits: null,
    minimumCredits: null,
    minimumApplied: false,
    rangePosition: range.position,
    credits: bounded(range.credits),
  };
}
export type CreditCostResult = ReturnType<typeof calculateCreditCost>;
