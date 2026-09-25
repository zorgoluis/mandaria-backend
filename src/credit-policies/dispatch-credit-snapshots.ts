import type {
  CreditAccountOwnerType,
  Prisma,
  ServiceType,
} from '@prisma/client';
import { SERVICE_EXECUTION_MODES } from '../independent-drivers/independent-driver-policy.js';
import {
  calculateCreditCost,
  creditPolicyError,
} from './credit-policy-engine.js';
import {
  POLICY_LOCK_NAMESPACE,
  resolveActiveCreditPolicy,
} from './credit-policies.service.js';

/**
 * V1.10-C: which actor types may be awarded a ServiceType, derived from the V1.9 execution policy
 * (FLEET -> providers, INDEPENDENT -> independent drivers, BOTH -> both). Only these actors get a
 * snapshot, and only their credit policies are required to open a Dispatch: an actor that can
 * never take the service needs no commercial configuration. Mirrored in SQL by
 * credit_required_actors() (migration 20260922001400).
 */
export type ExecutionMode = 'FLEET' | 'INDEPENDENT' | 'BOTH';
export function creditActorsFor(
  serviceType: ServiceType,
  // Injectable only so tests can exercise FLEET-only / INDEPENDENT-only services before one exists.
  modes: Partial<Record<ServiceType, ExecutionMode>> = SERVICE_EXECUTION_MODES,
): CreditAccountOwnerType[] {
  const mode = modes[serviceType];
  return [
    ...(mode === 'FLEET' || mode === 'BOTH' ? (['PROVIDER'] as const) : []),
    ...(mode === 'INDEPENDENT' || mode === 'BOTH'
      ? (['INDEPENDENT_DRIVER'] as const)
      : []),
  ];
}

export const dispatchCreditSnapshotSelect = {
  id: true,
  actorType: true,
  serviceType: true,
  creditPolicyId: true,
  policyVersion: true,
  calculationType: true,
  distanceMeters: true,
  billableKm: true,
  creditsPerKm: true,
  minimumCredits: true,
  calculatedCredits: true,
  flatCredits: true,
  appliedRangeId: true,
  appliedRangePosition: true,
  appliedRangeMinDistanceMeters: true,
  appliedRangeMaxDistanceMeters: true,
  credits: true,
  createdAt: true,
} satisfies Prisma.DispatchCreditSnapshotSelect;

/**
 * Freezes, inside the transaction that opens the Dispatch, the credit cost for every actor that may
 * be awarded it. Inputs are only the ACTIVE policy and the canonical distance of the quote (fixed
 * by routing when the quote was made): no routing call, no account, no balance. Per actor, a
 * shared advisory lock keeps a concurrent policy version from being written until this opening
 * commits, so the snapshot always references a complete version that was ACTIVE throughout.
 *
 * Fails closed: a missing ACTIVE policy (CREDIT_POLICY_UNAVAILABLE) or a cost outside 1..1,000,000
 * (CREDIT_COST_OUT_OF_RANGE) aborts the whole opening — the quote acceptance rolls back, so no
 * Dispatch is ever awardable without its cost and no service is ever silently free.
 */
export async function createDispatchCreditSnapshots(
  tx: Prisma.TransactionClient,
  dispatchId: string,
  quote: { serviceType: ServiceType; distanceMeters: number },
  actors: CreditAccountOwnerType[] = creditActorsFor(quote.serviceType),
) {
  const snapshots = [];
  for (const actorType of actors) {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock_shared(${POLICY_LOCK_NAMESPACE}::int, hashtext(${`${quote.serviceType}:${actorType}`}))`;
    const policy = await resolveActiveCreditPolicy(
      tx,
      quote.serviceType,
      actorType,
    );
    const cost = calculateCreditCost({
      policy,
      distanceMeters: quote.distanceMeters,
    });
    // The engine allows 0 (PER_KM with minimumCredits 0 at 0 m); an awardable service does not.
    if (cost.credits < 1)
      throw creditPolicyError(
        'CREDIT_COST_OUT_OF_RANGE',
        `A service must cost at least 1 credit; ${quote.serviceType} / ${actorType} policy v${policy.version} yields 0 for ${quote.distanceMeters} m (raise minimumCredits)`,
      );
    const range =
      cost.calculationType === 'DISTANCE_RANGE'
        ? policy.ranges.find((r) => r.position === cost.rangePosition)!
        : null;
    snapshots.push(
      await tx.dispatchCreditSnapshot.create({
        data: {
          dispatchId,
          actorType,
          serviceType: quote.serviceType,
          creditPolicyId: policy.id,
          policyVersion: policy.version,
          calculationType: policy.calculationType,
          distanceMeters: quote.distanceMeters,
          billableKm: cost.billableKm,
          creditsPerKm:
            policy.calculationType === 'PER_KM' ? policy.creditsPerKm : null,
          minimumCredits:
            policy.calculationType === 'PER_KM' ? policy.minimumCredits : null,
          calculatedCredits: cost.calculatedCredits,
          flatCredits:
            policy.calculationType === 'FLAT' ? policy.flatCredits : null,
          appliedRangeId: range?.id ?? null,
          appliedRangePosition: range?.position ?? null,
          appliedRangeMinDistanceMeters: range?.minDistanceMeters ?? null,
          appliedRangeMaxDistanceMeters: range ? range.maxDistanceMeters : null,
          credits: cost.credits,
        },
        select: dispatchCreditSnapshotSelect,
      }),
    );
  }
  return snapshots;
}

/** The cost an actor would be charged for a Dispatch, or null for a legacy (pre-V1.10-C) one. */
export function creditCostFor(
  snapshots: { actorType: CreditAccountOwnerType; credits: number }[],
  actorType: CreditAccountOwnerType,
) {
  return snapshots.find((s) => s.actorType === actorType)?.credits ?? null;
}
