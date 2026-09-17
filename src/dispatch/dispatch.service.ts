import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  DispatchCandidateStatus,
  DispatchStatus,
  ServiceType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { pageResult } from '../common/pagination.dto.js';
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

type LockedDispatch = {
  id: string;
  status: DispatchStatus;
  expiresAt: Date;
  claimedByProviderId: string | null;
  serviceZoneId: string;
  serviceType: ServiceType;
};
const REJECTION_MESSAGES: Record<DispatchErrorCode, string> = {
  DISPATCH_EXPIRED: 'Dispatch window has closed',
  DISPATCH_CANCELLED: 'Dispatch was cancelled',
  DISPATCH_ALREADY_CLAIMED: 'Dispatch was already claimed by another provider',
  DISPATCH_RECLAIM_NOT_ALLOWED:
    'This provider released the dispatch and cannot claim it again',
  DISPATCH_NOT_CLAIMED_BY_PROVIDER:
    'Dispatch is not currently claimed by this provider',
  PROVIDER_NOT_ELIGIBLE:
    'Provider is no longer eligible for this service zone and type',
  SERVICE_COVERAGE_EXISTS: 'Coverage already exists',
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
  constructor(private readonly prisma: PrismaService) {}

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
      items.map((d) => providerDispatchView(d, providerId, now)),
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
    return providerDispatchView(dispatch, providerId);
  }

  /**
   * Claims an OPEN dispatch for a candidate provider. The dispatch row is locked FOR UPDATE, so
   * concurrent claims run one after another and every later attempt sees CLAIMED (409). The
   * partial unique index on CLAIMED candidates and the Dispatch trigger back this up in SQL.
   */
  async claim(dispatchId: string, providerId: string, actorUserId: string) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const dispatch = await this.lock(tx, dispatchId);
      const candidate = await this.candidate(tx, dispatchId, providerId);
      const now = new Date();
      const rejection = claimRejection(dispatch, candidate, providerId, now);
      if (rejection === 'ALREADY_OWNER') return { kind: 'already' as const };
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
      return { kind: 'claimed' as const };
    });
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
    if (outcome.kind === 'claimed')
      this.logger.log({
        event: 'DISPATCH_CLAIMED',
        dispatchId,
        providerId,
        actorUserId,
      });
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
    const outcome = await this.prisma.$transaction(async (tx) => {
      const dispatch = await this.lock(tx, dispatchId);
      await this.candidate(tx, dispatchId, providerId);
      if (
        dispatch.status !== 'CLAIMED' ||
        dispatch.claimedByProviderId !== providerId
      )
        throw reject('DISPATCH_NOT_CLAIMED_BY_PROVIDER');
      const now = new Date();
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
      return { expired };
    });
    this.logger.log({
      event: 'DISPATCH_RELEASED',
      dispatchId,
      providerId,
      actorUserId,
      reason,
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
    >`SELECT d.id, d.status, d."expiresAt", d."claimedByProviderId", q."serviceZoneId", q."serviceType" FROM "Dispatch" d JOIN "DeliveryQuote" q ON q.id = d."deliveryQuoteId" WHERE d.id = ${dispatchId}::uuid FOR UPDATE OF d`;
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
