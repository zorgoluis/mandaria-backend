import type { Prisma } from '@prisma/client';
import type {
  CreditAccountOwnerType,
  DispatchCreditMode,
} from '@prisma/client';
import { isUniqueViolation } from '../providers/provider-capacity.js';
import { DomainException } from '../common/domain-error.js';
import {
  creditError,
  isLedgerRejection,
  nextBalance,
} from './credit-policy.js';

/** Who pays, always resolved by the server from the winner of the award, never from the request. */
export type AwardOwner =
  | { actorType: 'PROVIDER'; providerId: string }
  | { actorType: 'INDEPENDENT_DRIVER'; independentDriverProfileId: string };

export type AwardedDispatch = { id: string; creditMode: DispatchCreditMode };

export type AwardOutcome =
  | { kind: 'legacy' }
  | {
      kind: 'charged';
      actorType: CreditAccountOwnerType;
      creditAccountId: string;
      credits: number;
      snapshotId: string;
      entryId: string;
      sequence: number;
      balanceBefore: number;
      balanceAfter: number;
    };

/** Economic reasons an award can be refused, for observability; anything else is not about credits. */
const AWARD_REJECTIONS = new Set([
  'INSUFFICIENT_CREDITS',
  'CREDIT_ACCOUNT_UNAVAILABLE',
  'CREDIT_SNAPSHOT_UNAVAILABLE',
  'CREDIT_MOVEMENT_CONFLICT',
]);
export const awardRejectionCode = (error: unknown) =>
  error instanceof DomainException && AWARD_REJECTIONS.has(error.code)
    ? error.code
    : null;

/**
 * V1.10-D: debits the frozen cost of a Dispatch to the actor that just won it, inside the caller's
 * transaction, so awarding the service and paying for it are one operation. The caller has already
 * locked the Dispatch row and performed the operational mutation (claim, or take with its
 * assignment); if this throws, that mutation rolls back with the debit.
 *
 * The cost is never recomputed: it is DispatchCreditSnapshot.credits frozen in V1.10-C. No credit
 * policy is resolved, no distance is recalculated and no routing provider is called, so changing
 * the policy afterwards cannot change what an open Dispatch costs.
 *
 * Order of work: snapshot -> account row FOR UPDATE -> balance check -> ledger insert. The account
 * lock serializes every movement of that account, so two claims paid from one balance cannot both
 * pass; in PostgreSQL the ledger trigger re-checks balanceBefore and the CHECK keeps the balance at
 * or above zero, and service_award_guard re-derives the amount from the snapshot and refuses a
 * charge to anyone but the holder. The lock order is always dispatch -> (driver, vehicle) ->
 * account, so claim and take cannot deadlock against each other.
 */
export async function chargeDispatchAward(
  tx: Prisma.TransactionClient,
  dispatch: AwardedDispatch,
  owner: AwardOwner,
  actorUserId: string,
): Promise<AwardOutcome> {
  // Dispatches opened before V1.10-C have no frozen cost and are never charged retroactively.
  if (dispatch.creditMode === 'LEGACY') return { kind: 'legacy' };
  const snapshot = await tx.dispatchCreditSnapshot.findUnique({
    where: {
      dispatchId_actorType: {
        dispatchId: dispatch.id,
        actorType: owner.actorType,
      },
    },
    select: { id: true, credits: true },
  });
  // A monetized Dispatch without its snapshot is corruption, never a free service.
  if (!snapshot)
    throw creditError(
      'CREDIT_SNAPSHOT_UNAVAILABLE',
      'This service has no frozen credit cost for this actor and cannot be awarded',
    );
  const [account] = await (owner.actorType === 'PROVIDER'
    ? tx.$queryRaw<{ id: string; balance: number }[]>`
        SELECT "id", "balance" FROM "CreditAccount"
         WHERE "providerId" = ${owner.providerId}::uuid FOR UPDATE`
    : tx.$queryRaw<{ id: string; balance: number }[]>`
        SELECT "id", "balance" FROM "CreditAccount"
         WHERE "independentDriverProfileId" = ${owner.independentDriverProfileId}::uuid FOR UPDATE`);
  // Accounts are created with their owner (V1.10-A trigger): a missing one is a configuration
  // problem for an administrator, never something to create silently while awarding a service.
  if (!account)
    throw creditError(
      'CREDIT_ACCOUNT_UNAVAILABLE',
      'There is no credit account to charge this service to',
    );
  const next = nextBalance(account.balance, -snapshot.credits);
  if ('rejection' in next)
    throw creditError(
      next.rejection,
      `Insufficient credits: this service costs ${snapshot.credits} and the balance is ${account.balance}`,
    );
  try {
    const entry = await tx.creditLedgerEntry.create({
      data: {
        creditAccountId: account.id,
        type: 'SERVICE_AWARD',
        amount: -snapshot.credits,
        balanceBefore: account.balance,
        balanceAfter: next.balanceAfter,
        // Identifies the service paid for; with the account (and so the actor) it names the
        // snapshot charged. The partial unique index allows one award per account and Dispatch.
        referenceType: 'DISPATCH',
        referenceId: dispatch.id,
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
      kind: 'charged',
      actorType: owner.actorType,
      creditAccountId: account.id,
      credits: snapshot.credits,
      snapshotId: snapshot.id,
      entryId: entry.id,
      sequence: entry.sequence,
      balanceBefore: entry.balanceBefore,
      balanceAfter: entry.balanceAfter,
    };
  } catch (error) {
    if (error instanceof DomainException) throw error;
    // Already charged for this Dispatch on this account: a retry that got this far, never a second
    // debit. The award itself is settled by the operational guarantees of V1.7/V1.9.
    if (isUniqueViolation(error))
      throw creditError(
        'CREDIT_MOVEMENT_CONFLICT',
        'This service was already charged to this credit account',
      );
    // A guard or CHECK firing under the lock means another writer moved the account: a conflict.
    if (isLedgerRejection(error))
      throw creditError(
        'CREDIT_MOVEMENT_CONFLICT',
        'The credit account changed while charging this service; try again',
      );
    throw error;
  }
}
