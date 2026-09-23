import type { Prisma } from '@prisma/client';
import type {
  CreditAccountOwnerType,
  CreditRefundReason,
} from '@prisma/client';
import { isUniqueViolation } from '../providers/provider-capacity.js';
import { DomainException } from '../common/domain-error.js';
import {
  creditError,
  isLedgerRejection,
  nextBalance,
} from './credit-policy.js';
import { creditEnforcementMode } from './award-boundary.js';
import type { AwardOwner } from './service-award.js';

/** The dispatch as the reversal sees it, with what V1.10-D needs to classify its award. */
export type ReversedDispatch = {
  id: string;
  creditMode: 'LEGACY' | 'MONETIZED';
  claimedAt: Date | null;
  preEnforcementAwards: {
    actorType: CreditAccountOwnerType;
    actorId: string;
    awardedAt: Date;
  }[];
};

export type RefundOutcome =
  | { kind: 'none'; boundary: 'LEGACY' | 'PRE_ENFORCEMENT_AWARD' }
  | { kind: 'already'; entryId: string; credits: number }
  | {
      kind: 'refunded';
      actorType: CreditAccountOwnerType;
      creditAccountId: string;
      credits: number;
      awardEntryId: string;
      entryId: string;
      sequence: number;
      balanceBefore: number;
      balanceAfter: number;
      reason: CreditRefundReason;
    };

const REFUND_REJECTIONS = new Set([
  'CREDIT_REFUND_INTEGRITY_ERROR',
  'CREDIT_MOVEMENT_CONFLICT',
]);
/** Event name for a reversal refused because its economy is corrupt, never a silent free pass. */
export const REFUND_INTEGRITY_EVENT = 'SERVICE_REFUND_INTEGRITY_FAILURE';
export const refundRejectionCode = (error: unknown) =>
  error instanceof DomainException && REFUND_REJECTIONS.has(error.code)
    ? error.code
    : null;

/**
 * V1.10-E: returns the credits of an award whose service was reversed, inside the caller's
 * transaction, right after the operational reversal it belongs to (a release, or the cancellation
 * of the delivery). The original SERVICE_AWARD is never touched: the refund is a new, opposite
 * entry that points at it, so the history shows both movements and their sum is the net impact.
 *
 * The amount comes from the award actually charged — never from the current policy, the snapshot
 * or a recalculation — and goes back to the very account that paid, found through the award
 * itself. Only full refunds exist in this version.
 *
 * Nothing is refunded when nothing was charged: a LEGACY dispatch and a claim that predates
 * enforcement have no award, and no credit is invented for them. But a dispatch that should have
 * been charged and has no award is corruption, and that fails closed instead of quietly passing
 * as a free reversal.
 */
export async function refundDispatchAward(
  tx: Prisma.TransactionClient,
  dispatch: ReversedDispatch,
  owner: AwardOwner,
  /** The id V1.10-D recorded for this actor: the provider, or the Driver of an independent. */
  boundaryActorId: string,
  reason: CreditRefundReason,
  actorUserId: string | null,
): Promise<RefundOutcome> {
  const boundary = creditEnforcementMode(
    dispatch,
    owner.actorType,
    boundaryActorId,
  );
  const account = await (owner.actorType === 'PROVIDER'
    ? tx.creditAccount.findUnique({
        where: { providerId: owner.providerId },
        select: { id: true },
      })
    : tx.creditAccount.findUnique({
        where: { independentDriverProfileId: owner.independentDriverProfileId },
        select: { id: true },
      }));
  const award = account
    ? await tx.creditLedgerEntry.findFirst({
        where: {
          type: 'SERVICE_AWARD',
          referenceId: dispatch.id,
          creditAccountId: account.id,
        },
        select: { id: true, amount: true, creditAccountId: true },
      })
    : null;
  if (!award) {
    // Never charged: the boundary says so, and that is a legitimate free reversal.
    if (boundary !== 'ENFORCED') return { kind: 'none', boundary };
    throw creditError(
      'CREDIT_REFUND_INTEGRITY_ERROR',
      'This service was awarded under credit enforcement but has no charge to return',
    );
  }
  const existing = await tx.creditLedgerEntry.findFirst({
    where: { type: 'SERVICE_REFUND', reversesEntryId: award.id },
    select: { id: true, amount: true },
  });
  // Already returned: a repeated release or a second cancellation adds nothing.
  if (existing)
    return { kind: 'already', entryId: existing.id, credits: existing.amount };
  const credits = -award.amount;
  const [locked] = await tx.$queryRaw<
    { balance: number }[]
  >`SELECT "balance" FROM "CreditAccount" WHERE "id" = ${award.creditAccountId}::uuid FOR UPDATE`;
  if (!locked)
    throw creditError(
      'CREDIT_REFUND_INTEGRITY_ERROR',
      'The credit account that paid this service no longer exists',
    );
  const next = nextBalance(locked.balance, credits);
  if ('rejection' in next)
    throw creditError(
      next.rejection,
      'Returning these credits would exceed the maximum balance',
    );
  try {
    const entry = await tx.creditLedgerEntry.create({
      data: {
        creditAccountId: award.creditAccountId,
        type: 'SERVICE_REFUND',
        amount: credits,
        balanceBefore: locked.balance,
        balanceAfter: next.balanceAfter,
        referenceType: 'DISPATCH',
        referenceId: dispatch.id,
        reversesEntryId: award.id,
        refundReason: reason,
        createdByUserId: actorUserId,
      },
      select: {
        id: true,
        sequence: true,
        balanceBefore: true,
        balanceAfter: true,
      },
    });
    return {
      kind: 'refunded',
      actorType: owner.actorType,
      creditAccountId: award.creditAccountId,
      credits,
      awardEntryId: award.id,
      entryId: entry.id,
      sequence: entry.sequence,
      balanceBefore: entry.balanceBefore,
      balanceAfter: entry.balanceAfter,
      reason,
    };
  } catch (error) {
    if (error instanceof DomainException) throw error;
    // Two reversals raced: the unique index kept the single refund the award is entitled to.
    if (isUniqueViolation(error))
      throw creditError(
        'CREDIT_MOVEMENT_CONFLICT',
        'These credits were already returned; retry the operation',
      );
    if (isLedgerRejection(error))
      throw creditError(
        'CREDIT_MOVEMENT_CONFLICT',
        'The credit account changed while returning these credits; try again',
      );
    throw error;
  }
}

/** Log fields shared by every reversal, so an audit reads the same in release and cancellation. */
export const refundLogFields = (outcome: RefundOutcome) =>
  outcome.kind === 'refunded'
    ? {
        event: 'SERVICE_REFUND_ISSUED' as const,
        actorType: outcome.actorType,
        creditAccountId: outcome.creditAccountId,
        credits: outcome.credits,
        awardEntryId: outcome.awardEntryId,
        entryId: outcome.entryId,
        sequence: outcome.sequence,
        balanceBefore: outcome.balanceBefore,
        balanceAfter: outcome.balanceAfter,
        refundReason: outcome.reason,
      }
    : outcome.kind === 'already'
      ? {
          event: 'SERVICE_REFUND_ALREADY_APPLIED' as const,
          entryId: outcome.entryId,
          credits: outcome.credits,
        }
      : {
          event:
            outcome.boundary === 'LEGACY'
              ? ('SERVICE_REFUND_SKIPPED_LEGACY' as const)
              : ('SERVICE_REFUND_SKIPPED_PRE_ENFORCEMENT' as const),
        };
