import { NotFoundException } from '@nestjs/common';
import type { DispatchStatus, Prisma } from '@prisma/client';
import { DomainException } from '../common/domain-error.js';
import {
  recordDeliveryCompleted,
  type B2bEvent,
} from '../b2b-events/b2b-outbox.js';
import { isGuardRejection } from '../independent-drivers/independent-driver-policy.js';

/**
 * The operational audit signal of a delivery, for whoever runs Mandaria: the dispatch itself
 * (`status`, `deliveredAt`, `deliveredByUserId`) plus the COMPLETED assignment, summarised in a
 * structured log line. It never carries tokens, secrets or personal data — only ids, the mode and
 * the timestamp. It is not the B2B event: since V1.12-B that is a durable row in `B2bOutboxEvent`,
 * addressed to the client, while this stays an internal trace.
 */
export const DELIVERY_COMPLETED_EVENT = 'DELIVERY_COMPLETED';

export const COMPLETION_ERRORS = {
  DISPATCH_NOT_CLAIMED_BY_PROVIDER: 409,
  DISPATCH_NOT_CLAIMED_BY_DRIVER: 409,
  NO_ACTIVE_ASSIGNMENT: 409,
  DELIVERY_CONFLICT: 409,
} as const;
export type CompletionErrorCode = keyof typeof COMPLETION_ERRORS;
export const completionError = (code: CompletionErrorCode, message: string) =>
  new DomainException(code, COMPLETION_ERRORS[code], message);

/**
 * Who is closing the service. There is exactly one legitimate actor per execution model and it is
 * always resolved from the JWT: the provider that holds the claim (through its PROVIDER_ADMIN) or
 * the independent driver that took it. SUPER_ADMIN, the B2B client and any other provider or
 * driver are not actors at all — they never reach this helper.
 */
export type CompletionActor =
  | { mode: 'FLEET'; providerId: string }
  | { mode: 'INDEPENDENT'; driverId: string };

type LockedDispatch = {
  status: DispatchStatus;
  deliveryRequestId: string;
  claimedByProviderId: string | null;
  claimedByIndependentDriverId: string | null;
  deliveredAt: Date | null;
  deliveredByUserId: string | null;
};

export type CompletionOutcome =
  | {
      kind: 'completed';
      assignmentId: string;
      deliveredAt: Date;
      event: B2bEvent;
    }
  | { kind: 'already'; deliveredAt: Date; deliveredByUserId: string };

const notOwner = (actor: CompletionActor) =>
  actor.mode === 'FLEET'
    ? completionError(
        'DISPATCH_NOT_CLAIMED_BY_PROVIDER',
        'Dispatch is not currently claimed by this provider',
      )
    : completionError(
        'DISPATCH_NOT_CLAIMED_BY_DRIVER',
        'Dispatch is not currently taken by this driver',
      );

const owns = (dispatch: LockedDispatch, actor: CompletionActor) =>
  actor.mode === 'FLEET'
    ? dispatch.claimedByProviderId === actor.providerId
    : dispatch.claimedByIndependentDriverId === actor.driverId;

/**
 * V1.11-A: the operational close of a service, shared by both execution models. Inside the
 * caller's transaction it locks the dispatch row — the same `FOR UPDATE` the claim, the take and
 * the release take, so a completion never races them — checks that the actor still holds the
 * claim, ends its ACTIVE assignment as COMPLETED and stamps the dispatch as DELIVERED. Either
 * both writes land or neither does.
 *
 * Closing the assignment is not bookkeeping: `dispatch_guard` refuses to move a dispatch out of
 * CLAIMED while an assignment is ACTIVE and refuses a DELIVERED dispatch without a COMPLETED one,
 * so the two writes are inseparable in SQL as well. COMPLETED reuses the V1.8 ending mechanism
 * (`endedAt`/`endedByUserId`, and no `endReason` because nothing failed) instead of inventing a
 * second way to end an assignment, which is what frees the Driver and the Vehicle: the partial
 * unique indexes only constrain ACTIVE rows, and the row itself stays as history.
 *
 * Nothing economic happens here. The credits charged at CLAIM/TAKE stay consumed, no ledger entry
 * is written and no SERVICE_REFUND is owed (`dispatch_award_refund_required` returns early for
 * DELIVERED). Nothing is recalculated either: no pricing, no routing, no policy, no snapshot.
 *
 * V1.12-B adds the third inseparable write: the `delivery.completed` B2B event. It is recorded in
 * this same transaction, so a delivered service and its event commit together or not at all, and a
 * deferred constraint refuses at COMMIT any new DELIVERED that has no event.
 *
 * Repeating the completion is the answer the legitimate actor already got: a DELIVERED dispatch
 * still held by the same actor returns `already` without writing — and therefore without a second
 * event — matching how a winner repeating its own claim gets 200 and no change. Any other actor
 * cannot even see it as delivered: it is simply not the owner.
 */
export async function completeDelivery(
  tx: Prisma.TransactionClient,
  dispatchId: string,
  actor: CompletionActor,
  actorUserId: string,
): Promise<CompletionOutcome> {
  const [dispatch] = await tx.$queryRaw<
    LockedDispatch[]
  >`SELECT d.status, d."deliveryRequestId", d."claimedByProviderId", d."claimedByIndependentDriverId", d."deliveredAt", d."deliveredByUserId" FROM "Dispatch" d WHERE d.id = ${dispatchId}::uuid FOR UPDATE OF d`;
  if (!dispatch) throw new NotFoundException('Dispatch not found');
  if (!owns(dispatch, actor)) throw notOwner(actor);
  if (dispatch.status === 'DELIVERED')
    return {
      kind: 'already',
      deliveredAt: dispatch.deliveredAt!,
      deliveredByUserId: dispatch.deliveredByUserId!,
    };
  if (dispatch.status !== 'CLAIMED') throw notOwner(actor);
  // A service is delivered by whoever was carrying it: without an ACTIVE assignment there is no
  // driver and no vehicle, and a claim alone is not a delivery.
  const [active] = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM "DeliveryAssignment" WHERE "dispatchId" = ${dispatchId}::uuid AND status = 'ACTIVE' FOR UPDATE`;
  if (!active)
    throw completionError(
      'NO_ACTIVE_ASSIGNMENT',
      'Assign a driver and a vehicle before completing the delivery',
    );
  const deliveredAt = new Date();
  // Order matters and is enforced in SQL: the assignment ends first, then the dispatch resolves.
  await tx.deliveryAssignment.update({
    where: { id: active.id },
    data: {
      status: 'COMPLETED',
      endedAt: deliveredAt,
      endedByUserId: actorUserId,
    },
  });
  await tx.dispatch.update({
    where: { id: dispatchId },
    data: {
      status: 'DELIVERED',
      deliveredAt,
      deliveredByUserId: actorUserId,
    },
  });
  // V1.12-B: the B2B fact, written here and not after the transaction, so a delivered service and
  // its event are the same commit. `deliveredAt` is handed over rather than read again, which is
  // what makes the event's clock the delivery's own. If this insert fails, the delivery does not
  // happen: the dispatch stays CLAIMED, the assignment stays ACTIVE and nothing is announced.
  const event = await recordDeliveryCompleted(
    tx,
    dispatchId,
    dispatch.deliveryRequestId,
    deliveredAt,
  );
  return { kind: 'completed', assignmentId: active.id, deliveredAt, event };
}

/**
 * Under the dispatch lock no guard should ever fire, but if one does it means the row changed
 * underneath us — a lost race, not an internal failure. It must reach the client as a 409, never
 * as a 500, exactly like TAKE_CONFLICT does for a take.
 */
export async function completing<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof DomainException) throw error;
    if (isGuardRejection(error))
      throw completionError(
        'DELIVERY_CONFLICT',
        'The dispatch or its assignment changed while completing the delivery',
      );
    throw error;
  }
}
