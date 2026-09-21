import type { Prisma } from '@prisma/client';

export const creditAccountSelect = {
  id: true,
  ownerType: true,
  providerId: true,
  independentDriverProfileId: true,
  balance: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CreditAccountSelect;
export type CreditAccountRecord = Prisma.CreditAccountGetPayload<{
  select: typeof creditAccountSelect;
}>;

export const creditEntrySelect = {
  id: true,
  sequence: true,
  creditAccountId: true,
  type: true,
  amount: true,
  balanceBefore: true,
  balanceAfter: true,
  rechargeMethod: true,
  externalReference: true,
  reason: true,
  referenceType: true,
  referenceId: true,
  createdByUserId: true,
  idempotencyKey: true,
  requestHash: true,
  createdAt: true,
} satisfies Prisma.CreditLedgerEntrySelect;
export type CreditEntryRecord = Prisma.CreditLedgerEntryGetPayload<{
  select: typeof creditEntrySelect;
}>;

/**
 * What the account owner (PROVIDER_ADMIN, independent DRIVER) sees of its own history: every
 * movement, its amounts and why it happened. Administrative internals — which SUPER_ADMIN acted
 * and the Idempotency-Key it used — stay out. The request fingerprint is never exposed to anyone.
 */
export function ownerEntryView(entry: CreditEntryRecord) {
  return {
    id: entry.id,
    sequence: entry.sequence,
    type: entry.type,
    amount: entry.amount,
    balanceBefore: entry.balanceBefore,
    balanceAfter: entry.balanceAfter,
    rechargeMethod: entry.rechargeMethod,
    externalReference: entry.externalReference,
    reason: entry.reason,
    referenceType: entry.referenceType,
    referenceId: entry.referenceId,
    createdAt: entry.createdAt,
  };
}

/** SUPER_ADMIN audit view: the owner view plus actor and Idempotency-Key. */
export function adminEntryView(entry: CreditEntryRecord) {
  return {
    ...ownerEntryView(entry),
    creditAccountId: entry.creditAccountId,
    createdByUserId: entry.createdByUserId,
    idempotencyKey: entry.idempotencyKey,
  };
}
