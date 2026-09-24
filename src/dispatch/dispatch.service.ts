import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  DispatchCandidateStatus,
  DispatchCreditMode,
  DispatchStatus,
  ServiceType,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  assignmentDeadline,
  assignmentTtlMinutes,
} from '../delivery-assignments/assignment-policy.js';
import { pageResult } from '../common/pagination.dto.js';
import {
  awardRejectionCode,
  chargeDispatchAward,
} from '../credits/service-award.js';
import type { AwardOutcome } from '../credits/service-award.js';
import { preEnforcementSelect } from '../credits/award-boundary.js';
import {
  REFUND_INTEGRITY_EVENT,
  refundDispatchAward,
  refundLogFields,
  refundRejectionCode,
} from '../credits/service-refund.js';
import { recordedEventLog } from '../b2b-events/b2b-outbox.js';
import { B2bWebhooksService } from '../b2b-webhooks/b2b-webhooks.service.js';
import {
  DELIVERY_COMPLETED_EVENT,
  completeDelivery,
  completing,
} from '../deliveries/delivery-completion.js';
import {
  claimRejection,
  dispatchError,
  eligibleProviderIds,
} from './dispatch-policy.js';
import type { DispatchErrorCode, DispatchView } from './dispatch-policy.js';
import {
  adminDispatchView,
  dispatchSelect,
  providerDispatchView,
} from './dispatch.select.js';
import type { DispatchRecord } from './dispatch.select.js';

type LockedDispatch = {
  id: string;
  status: DispatchStatus;
  expiresAt: Date;
  claimedByProviderId: string | null;
  creditMode: DispatchCreditMode;
  claimedAt: Date | null;
  serviceZoneId: string;
  serviceType: ServiceType;
};
const REJECTION_MESSAGES: Record<DispatchErrorCode, string> = {
  DISPATCH_EXPIRED: 'Dispatch window has closed',
  DISPATCH_CANCELLED: 'Dispatch was cancelled',
  DISPATCH_ALREADY_CLAIMED: 'Dispatch was already claimed by another provider',
  DISPATCH_DELIVERED: 'Dispatch was already delivered and is closed',
  DISPATCH_RECLAIM_NOT_ALLOWED:
    'This provider released the dispatch and cannot claim it again',
  DISPATCH_NOT_CLAIMED_BY_PROVIDER:
    'Dispatch is not currently claimed by this provider',
  PROVIDER_NOT_ELIGIBLE:
    'Provider is no longer eligible for this service zone and type',
  SERVICE_COVERAGE_EXISTS: 'Coverage already exists',
  DISPATCH_HAS_ACTIVE_ASSIGNMENT:
    'Cancel the active delivery assignment before releasing the dispatch',
};
const reject = (code: DispatchErrorCode) =>
  dispatchError(code, REJECTION_MESSAGES[code]);

/** Effective-status filter: OPEN means still inside its window; EXPIRED includes lapsed OPEN. */
function statusWhere(
  status: DispatchStatus | undefined,
  now: Date,
): Prisma.DispatchWhereInput {
  if (status === 'OPEN') return { status: 'OPEN', expiresAt: { gt: now } };
  if (status === 'EXPIRED')
    return {
      OR: [{ status: 'EXPIRED' }, { status: 'OPEN', expiresAt: { lte: now } }],
    };
  return status ? { status } : {};
}

@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly webhooks: B2bWebhooksService,
  ) {}

  /** Assignment deadline (claimedAt + ServiceType TTL) and whether the owner is overdue. */
  private deadline(dispatch: DispatchRecord, now: Date) {
    return assignmentDeadline(
      dispatch,
      dispatch.deliveryAssignments.length > 0,
      assignmentTtlMinutes(this.config, dispatch.deliveryQuote.serviceType),
      now,
    );
  }

  /** Dispatches where the provider was a candidate (claim owners always are). */
  async listForProvider(
    providerId: string,
    query: {
      page: number;
      pageSize: number;
      view?: DispatchView;
      status?: DispatchStatus;
    },
  ) {
    const now = new Date();
    const view: Prisma.DispatchWhereInput =
      query.view === 'AVAILABLE'
        ? {
            status: 'OPEN',
            expiresAt: { gt: now },
            candidates: { some: { providerId, status: 'OFFERED' } },
          }
        : query.view === 'CLAIMED'
          ? { status: 'CLAIMED', claimedByProviderId: providerId }
          : {};
    const where: Prisma.DispatchWhereInput = {
      AND: [
        { candidates: { some: { providerId } } },
        view,
        statusWhere(query.status, now),
      ],
    };
    const [items, total] = await this.page(where, query, {
      // Claimable work first by closing window; history newest first.
      orderBy:
        query.view === 'AVAILABLE'
          ? [{ expiresAt: 'asc' }, { id: 'asc' }]
          : [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return pageResult(
      items.map((d) =>
        providerDispatchView(d, providerId, now, this.deadline(d, now)),
      ),
      total,
      query,
    );
  }

  async getForProvider(dispatchId: string, providerId: string) {
    const dispatch = await this.prisma.dispatch.findFirst({
      where: { id: dispatchId, candidates: { some: { providerId } } },
      select: dispatchSelect,
    });
    // Non-candidates get the same 404 as an unknown id: ids cannot be probed.
    if (!dispatch) throw new NotFoundException('Dispatch not found');
    const now = new Date();
    return providerDispatchView(
      dispatch,
      providerId,
      now,
      this.deadline(dispatch, now),
    );
  }

  /**
   * Claims an OPEN dispatch for a candidate provider. The dispatch row is locked FOR UPDATE, so
   * concurrent claims run one after another and every later attempt sees CLAIMED (409). The
   * partial unique index on CLAIMED candidates and the Dispatch trigger back this up in SQL.
   *
   * V1.10-D: claiming a monetized dispatch and paying its frozen cost are the same transaction.
   * The provider pays from its own credit account — a fleet driver never pays — and the charge is
   * exactly DispatchCreditSnapshot.credits, with no policy lookup and no routing call. Without
   * enough credits nothing happens at all: no claim, no candidate change, no ledger entry.
   */
  async claim(dispatchId: string, providerId: string, actorUserId: string) {
    const outcome = await this.charging(
      { dispatchId, providerId, actorUserId },
      this.prisma.$transaction(async (tx) => {
        const dispatch = await this.lock(tx, dispatchId);
        const candidate = await this.candidate(tx, dispatchId, providerId);
        const now = new Date();
        const rejection = claimRejection(dispatch, candidate, providerId, now);
        if (rejection === 'ALREADY_OWNER') {
          const historical = await tx.dispatchPreEnforcementAward.findFirst({
            where: {
              dispatchId,
              actorType: 'PROVIDER',
              actorId: providerId,
              awardedAt: dispatch.claimedAt!,
            },
            select: { id: true },
          });
          return { kind: 'already' as const, historical: !!historical };
        }
        if (rejection === 'DISPATCH_EXPIRED' && dispatch.status === 'OPEN') {
          await tx.dispatch.update({
            where: { id: dispatchId },
            data: { status: 'EXPIRED', expiredAt: now },
          });
          return { kind: 'expired' as const };
        }
        if (rejection) throw reject(rejection);
        const eligible = await eligibleProviderIds(
          tx,
          dispatch.serviceZoneId,
          dispatch.serviceType,
          providerId,
        );
        if (!eligible.length) throw reject('PROVIDER_NOT_ELIGIBLE');
        await tx.dispatchCandidate.update({
          where: { dispatchId_providerId: { dispatchId, providerId } },
          data: { status: 'CLAIMED', claimedAt: now },
        });
        await tx.dispatch.update({
          where: { id: dispatchId },
          data: {
            status: 'CLAIMED',
            claimedByProviderId: providerId,
            claimedAt: now,
          },
        });
        // Charged last, with the claim already written: the guard in PostgreSQL only accepts a
        // charge from the actor holding the dispatch, and a rejection here rolls the claim back.
        const award = await chargeDispatchAward(
          tx,
          { id: dispatchId, creditMode: dispatch.creditMode },
          { actorType: 'PROVIDER', providerId },
          actorUserId,
        );
        return { kind: 'claimed' as const, award };
      }),
    );
    if (outcome.kind === 'expired') {
      this.logger.log({
        event: 'DISPATCH_EXPIRED',
        dispatchId,
        providerId,
        actorUserId,
        reason: 'CLAIM_AFTER_WINDOW',
      });
      throw reject('DISPATCH_EXPIRED');
    }
    if (outcome.kind === 'already' && outcome.historical) {
      this.logger.log({
        event: 'PRE_ENFORCEMENT_AWARD',
        dispatchId,
        providerId,
        actorUserId,
      });
    }
    if (outcome.kind === 'claimed') {
      this.logger.log({
        event: 'DISPATCH_CLAIMED',
        dispatchId,
        providerId,
        actorUserId,
      });
      this.logAward(outcome.award, { dispatchId, providerId, actorUserId });
    }
    return this.getForProvider(dispatchId, providerId);
  }

  /**
   * The claim owner gives the dispatch back. Inside the window it reopens for the remaining
   * OFFERED candidates (never for the releasing provider); after the window it becomes EXPIRED.
   */
  async release(
    dispatchId: string,
    providerId: string,
    reason: string,
    actorUserId: string,
  ) {
    const outcome = await this.reversing(
      { dispatchId, providerId, actorUserId },
      this.prisma.$transaction(async (tx) => {
        const dispatch = await this.lock(tx, dispatchId);
        await this.candidate(tx, dispatchId, providerId);
        if (
          dispatch.status !== 'CLAIMED' ||
          dispatch.claimedByProviderId !== providerId
        )
          throw reject('DISPATCH_NOT_CLAIMED_BY_PROVIDER');
        // V1.8: resources must be freed first; the dispatch trigger enforces this in SQL too.
        if (
          await tx.deliveryAssignment.findFirst({
            where: { dispatchId, status: 'ACTIVE' },
            select: { id: true },
          })
        )
          throw dispatchError(
            'DISPATCH_HAS_ACTIVE_ASSIGNMENT',
            'Cancel the active delivery assignment before releasing the dispatch',
          );
        const now = new Date();
        // Read before the claim is cleared: the boundary of V1.10-D is identified by claimedAt.
        const awarded = await tx.dispatch.findUniqueOrThrow({
          where: { id: dispatchId },
          select: {
            creditMode: true,
            claimedAt: true,
            preEnforcementAwards: { select: preEnforcementSelect },
          },
        });
        await tx.dispatchCandidate.update({
          where: { dispatchId_providerId: { dispatchId, providerId } },
          data: { status: 'RELEASED', releasedAt: now, releaseReason: reason },
        });
        const expired = now >= dispatch.expiresAt;
        await tx.dispatch.update({
          where: { id: dispatchId },
          data: {
            status: expired ? 'EXPIRED' : 'OPEN',
            claimedByProviderId: null,
            claimedAt: null,
            ...(expired ? { expiredAt: now } : {}),
          },
        });
        // V1.10-E: giving the service back returns exactly the credits its award charged, in this
        // same transaction. A service that was never charged returns nothing.
        const refund = await refundDispatchAward(
          tx,
          { id: dispatchId, ...awarded },
          { actorType: 'PROVIDER', providerId },
          providerId,
          'PROVIDER_RELEASE',
          actorUserId,
        );
        return { expired, refund };
      }),
    );
    this.logger.log({
      event: 'DISPATCH_RELEASED',
      dispatchId,
      providerId,
      actorUserId,
      reason,
    });
    this.logger.log({
      ...refundLogFields(outcome.refund),
      dispatchId,
      providerId,
      actorUserId,
    });
    if (outcome.expired)
      this.logger.log({
        event: 'DISPATCH_EXPIRED',
        dispatchId,
        providerId,
        actorUserId,
        reason: 'RELEASED_AFTER_WINDOW',
      });
    return this.getForProvider(dispatchId, providerId);
  }

  /**
   * V1.11-A: the provider that holds the claim declares the service delivered. One transaction
   * ends its ACTIVE assignment as COMPLETED and resolves the dispatch as DELIVERED, which is
   * terminal: the service can no longer be released, reassigned or cancelled, and the driver and
   * the vehicle are free for the next one. It costs zero credits and returns zero — the award paid
   * at claim time is what the delivery earns.
   */
  async complete(dispatchId: string, providerId: string, actorUserId: string) {
    const outcome = await completing(
      this.prisma.$transaction(async (tx) => {
        // Same visibility rule as claim and release: a non-candidate cannot tell this dispatch
        // from a missing one, so ids stay unprobeable.
        await this.candidate(tx, dispatchId, providerId);
        return completeDelivery(
          tx,
          dispatchId,
          { mode: 'FLEET', providerId },
          actorUserId,
        );
      }),
    );
    if (outcome.kind === 'completed') {
      this.logger.log({
        event: DELIVERY_COMPLETED_EVENT,
        dispatchId,
        assignmentId: outcome.assignmentId,
        mode: 'FLEET',
        providerId,
        actorUserId,
        deliveredAt: outcome.deliveredAt.toISOString(),
      });
      this.logger.log(recordedEventLog(outcome.event));
      // V1.12-D: the transaction has already committed and the event is durable, so this is
      // only a nudge for latency. If the process dies right here the worker rediscovers the
      // event from the outbox; transport never decides whether a delivery happened.
      this.webhooks.nudge();
    }
    return this.getForProvider(dispatchId, providerId);
  }

  async listForAdmin(query: {
    page: number;
    pageSize: number;
    status?: DispatchStatus;
    providerId?: string;
    deliveryRequestPublicId?: string;
  }) {
    const now = new Date();
    const where: Prisma.DispatchWhereInput = {
      AND: [
        statusWhere(query.status, now),
        query.providerId
          ? { candidates: { some: { providerId: query.providerId } } }
          : {},
        query.deliveryRequestPublicId
          ? { deliveryRequest: { publicId: query.deliveryRequestPublicId } }
          : {},
      ],
    };
    const [items, total] = await this.page(where, query, {
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return pageResult(
      items.map((d) => adminDispatchView(d, now)),
      total,
      query,
    );
  }

  async getForAdmin(dispatchId: string) {
    const dispatch = await this.prisma.dispatch.findUnique({
      where: { id: dispatchId },
      select: dispatchSelect,
    });
    if (!dispatch) throw new NotFoundException('Dispatch not found');
    return adminDispatchView(dispatch);
  }

  /** One line per economic outcome of an award: charged, or skipped because the dispatch is legacy. */
  private logAward(
    award: AwardOutcome,
    context: { dispatchId: string; providerId: string; actorUserId: string },
  ) {
    if (award.kind === 'legacy') {
      this.logger.log({
        event: 'LEGACY_DISPATCH_CREDIT_SKIPPED',
        ...context,
        reason: 'DISPATCH_OPENED_BEFORE_CREDIT_SNAPSHOTS',
      });
      return;
    }
    this.logger.log({
      event: 'SERVICE_AWARD_CHARGED',
      ...context,
      actorType: award.actorType,
      creditAccountId: award.creditAccountId,
      credits: award.credits,
      creditSnapshotId: award.snapshotId,
      entryId: award.entryId,
      sequence: award.sequence,
      balanceBefore: award.balanceBefore,
      balanceAfter: award.balanceAfter,
    });
  }

  /** Reports why an award was refused for economic reasons; the rejection itself is the answer. */
  private async charging<T>(
    context: { dispatchId: string; providerId: string; actorUserId: string },
    work: Promise<T>,
  ) {
    try {
      return await work;
    } catch (error) {
      const code = awardRejectionCode(error);
      if (code)
        this.logger.warn({
          event:
            code === 'INSUFFICIENT_CREDITS'
              ? 'SERVICE_AWARD_REJECTED_INSUFFICIENT_CREDITS'
              : 'SERVICE_AWARD_REJECTED',
          ...context,
          code,
        });
      throw error;
    }
  }

  /** Reports a reversal refused because the award it should return is missing (corruption). */
  private async reversing<T>(
    context: { dispatchId: string; providerId: string; actorUserId: string },
    work: Promise<T>,
  ) {
    try {
      return await work;
    } catch (error) {
      if (refundRejectionCode(error) === 'CREDIT_REFUND_INTEGRITY_ERROR')
        this.logger.error({
          event: REFUND_INTEGRITY_EVENT,
          ...context,
          code: 'CREDIT_REFUND_INTEGRITY_ERROR',
        });
      throw error;
    }
  }

  private page(
    where: Prisma.DispatchWhereInput,
    query: { page: number; pageSize: number },
    options: { orderBy: Prisma.DispatchOrderByWithRelationInput[] },
  ) {
    return this.prisma.$transaction(
      [
        this.prisma.dispatch.findMany({
          where,
          select: dispatchSelect,
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          orderBy: options.orderBy,
        }),
        this.prisma.dispatch.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  private async lock(tx: Prisma.TransactionClient, dispatchId: string) {
    const [row] = await tx.$queryRaw<
      LockedDispatch[]
    >`SELECT d.id, d.status, d."expiresAt", d."claimedByProviderId", d."creditMode", d."claimedAt", q."serviceZoneId", q."serviceType" FROM "Dispatch" d JOIN "DeliveryQuote" q ON q.id = d."deliveryQuoteId" WHERE d.id = ${dispatchId}::uuid FOR UPDATE OF d`;
    if (!row) throw new NotFoundException('Dispatch not found');
    return row;
  }

  /** A provider that is not a candidate cannot tell this dispatch from a missing one. */
  private async candidate(
    tx: Prisma.TransactionClient,
    dispatchId: string,
    providerId: string,
  ) {
    const candidate = await tx.dispatchCandidate.findUnique({
      where: { dispatchId_providerId: { dispatchId, providerId } },
      select: { status: true },
    });
    if (!candidate) throw new NotFoundException('Dispatch not found');
    return candidate as { status: DispatchCandidateStatus };
  }
}
