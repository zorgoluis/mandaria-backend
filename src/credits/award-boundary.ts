import type {
  CreditAccountOwnerType,
  DispatchCreditMode,
} from '@prisma/client';

export const creditEnforcementModes = [
  'LEGACY',
  'PRE_ENFORCEMENT_AWARD',
  'ENFORCED',
] as const;
export const creditEnforcementDoc =
  'Persisted credit boundary: LEGACY predates snapshots and is not charged; PRE_ENFORCEMENT_AWARD identifies the current historical V1.10-C award, preserved without retroactive debit; ENFORCED requires the exact snapshot debit for a new award. This is not a payment receipt. After release, a new award is ENFORCED even when an older award was exempt.';
export const preEnforcementSelect = {
  actorType: true,
  actorId: true,
  awardedAt: true,
} as const;

export function creditEnforcementMode(
  dispatch: {
    creditMode: DispatchCreditMode;
    claimedAt: Date | null;
    preEnforcementAwards: {
      actorType: CreditAccountOwnerType;
      actorId: string;
      awardedAt: Date;
    }[];
  },
  actorType: CreditAccountOwnerType,
  actorId: string | null,
) {
  if (dispatch.creditMode === 'LEGACY') return 'LEGACY' as const;
  return actorId &&
    dispatch.claimedAt &&
    dispatch.preEnforcementAwards.some(
      (h) =>
        h.actorType === actorType &&
        h.actorId === actorId &&
        h.awardedAt.getTime() === dispatch.claimedAt!.getTime(),
    )
    ? ('PRE_ENFORCEMENT_AWARD' as const)
    : ('ENFORCED' as const);
}
