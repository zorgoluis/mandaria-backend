import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  DeliveryAssignmentEndReason,
  DispatchCreditMode,
  DispatchStatus,
  IndependentDriverStatus,
  ServiceType,
  VehicleStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { pageResult } from '../common/pagination.dto.js';
import { isUniqueViolation } from '../providers/provider-capacity.js';
import { DomainException } from '../common/domain-error.js';
import {
  awardRejectionCode,
  chargeDispatchAward,
} from '../credits/service-award.js';
import type { AwardOutcome } from '../credits/service-award.js';
import {
  RELEASE_END_REASON,
  independentError,
  independentServiceTypes,
  isGuardRejection,
  takeRejection,
} from './independent-driver-policy.js';
import type {
  IndependentReleaseReason,
  TakeRejectionCode,
} from './independent-driver-policy.js';
import {
  driverDispatchSelect,
  driverDispatchView,
} from './independent-dispatch.select.js';
import { independentVehicleSelect } from './independent-drivers.select.js';

type LockedDispatch = {
  id: string;
  status: DispatchStatus;
  expiresAt: Date;
  claimedByProviderId: string | null;
  claimedByIndependentDriverId: string | null;
  creditMode: DispatchCreditMode;
  claimedAt: Date | null;
  serviceType: ServiceType;
};
type ApprovedDriver = { driverId: string; profileId: string };

@Injectable()
export class IndependentDispatchesService {
  private readonly logger = new Logger(IndependentDispatchesService.name);
  constructor(private readonly prisma: PrismaService) {}

  /** The driver's own capability, as returned inside GET /driver/me. */
  async profileForUser(userId: string) {
    const driver = await this.prisma.driver.findUnique({
      where: { userId },
      select: {
        id: true,
        independentProfile: {
          select: {
            id: true,
            status: true,
            approvedAt: true,
            suspendedAt: true,
            reason: true,
          },
        },
      },
    });
    if (!driver?.independentProfile) return null;
    const busy = await this.prisma.deliveryAssignment.findFirst({
      where: { driverId: driver.id, status: 'ACTIVE' },
      select: { id: true, mode: true, dispatchId: true },
    });
    return {
      ...driver.independentProfile,
      // A driver busy as fleet cannot take an independent service either, and vice versa (§29).
      canTakeServices: driver.independentProfile.status === 'APPROVED' && !busy,
      activeAssignment: busy,
    };
  }

  /** The driver's own vehicles, to choose a vehicleId for POST /driver/dispatches/:id/take. */
  async myVehicles(userId: string) {
    const { profileId } = await this.approvedDriver(this.prisma, userId);
    return this.prisma.vehicle.findMany({
      where: { independentDriverProfileId: profileId },
      select: independentVehicleSelect,
      orderBy: [{ identifier: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Dispatches an approved independent driver may take right now: OPEN, inside their window and
   * of a ServiceType whose policy admits independents (§14). Dispatches this driver already gave
   * back are excluded, matching the V1.7 rule that a released service is not offered again to
   * whoever released it. Eligibility of the driver itself (busy, vehicle) is resolved at take
   * time, under locks; it cannot be decided reliably by a listing.
   */
  async available(userId: string, query: { page: number; pageSize: number }) {
    const { driverId } = await this.approvedDriver(this.prisma, userId);
    const now = new Date();
    const where: Prisma.DispatchWhereInput = {
      status: 'OPEN',
      expiresAt: { gt: now },
      deliveryQuote: { serviceType: { in: independentServiceTypes } },
      deliveryAssignments: { none: { driverId, status: 'CANCELLED' } },
    };
    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.dispatch.findMany({
          where,
          select: driverDispatchSelect,
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          // Closing window first: the most urgent offer is the one about to lapse.
          orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
        }),
        this.prisma.dispatch.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return pageResult(
      items.map((d) => driverDispatchView(d, driverId, now)),
      total,
      query,
    );
  }

  /** Detail of a dispatch this driver may take or already took; anything else is a 404. */
  async get(userId: string, dispatchId: string) {
    const { driverId } = await this.approvedDriver(this.prisma, userId);
    return this.viewFor(driverId, dispatchId);
  }

  /**
   * Renders the dispatch for a driver already resolved. take and release use this instead of get:
   * their work is committed by then, and re-running the approval gate would let a suspension that
   * lands in between turn a successful operation into a 409 the caller cannot trust.
   */
  private async viewFor(driverId: string, dispatchId: string) {
    const now = new Date();
    const dispatch = await this.prisma.dispatch.findFirst({
      where: {
        id: dispatchId,
        OR: [
          { claimedByIndependentDriverId: driverId },
          {
            status: 'OPEN',
            deliveryQuote: { serviceType: { in: independentServiceTypes } },
          },
        ],
      },
      select: driverDispatchSelect,
    });
    if (!dispatch) throw new NotFoundException('Dispatch not found');
    return driverDispatchView(dispatch, driverId, now);
  }

  /**
   * TAKE = CLAIM + ASSIGNMENT, atomically (§20-§22). One transaction locks the dispatch row
   * FOR UPDATE — the very same lock the provider claim takes — so a provider CLAIM and an
   * independent TAKE on the same dispatch serialize and exactly one wins (§31); the loser sees
   * CLAIMED and gets 409. Then the driver and the vehicle rows are locked (dispatch → driver →
   * vehicle, the V1.8 order) before the dispatch becomes CLAIMED and the ACTIVE assignment is
   * inserted. Nothing can commit a claim without its assignment or an assignment without its
   * claim: they are the same transaction, and delivery_assignment_guard re-checks the claim in
   * SQL. The partial unique indexes on ACTIVE rows (dispatch, driver, vehicle) are the last line
   * of defence and are global, so fleet and independent work exclude each other (§29, §30).
   */
  async take(userId: string, dispatchId: string, vehicleId: string) {
    const actor = await this.approvedDriver(this.prisma, userId);
    const outcome = await this.charging(
      { dispatchId, driverId: actor.driverId, actorUserId: userId },
      this.transaction(async (tx) => {
        const dispatch = await this.lock(tx, dispatchId);
        const now = new Date();
        const released = await tx.deliveryAssignment.findFirst({
          where: { dispatchId, driverId: actor.driverId, status: 'CANCELLED' },
          select: { id: true },
        });
        if (
          dispatch.claimedByIndependentDriverId === actor.driverId &&
          dispatch.claimedAt
        ) {
          const historical = await tx.dispatchPreEnforcementAward.findFirst({
            where: {
              dispatchId,
              actorType: 'INDEPENDENT_DRIVER',
              actorId: actor.driverId,
              awardedAt: dispatch.claimedAt,
            },
            select: { id: true },
          });
          if (historical)
            this.logger.log({
              event: 'PRE_ENFORCEMENT_AWARD',
              dispatchId,
              driverId: actor.driverId,
            });
        }
        const rejection = takeRejection(dispatch, released !== null, now);
        if (rejection === 'DISPATCH_EXPIRED' && dispatch.status === 'OPEN') {
          await tx.dispatch.update({
            where: { id: dispatchId },
            data: { status: 'EXPIRED', expiredAt: now },
          });
          return { kind: 'expired' as const };
        }
        if (rejection)
          throw independentError(rejection, REJECTION_MESSAGES[rejection]);
        await this.lockEligibleResources(tx, actor, vehicleId);
        await tx.dispatch.update({
          where: { id: dispatchId },
          data: {
            status: 'CLAIMED',
            claimedByIndependentDriverId: actor.driverId,
            claimedAt: now,
          },
        });
        const assignment = await tx.deliveryAssignment.create({
          data: {
            dispatchId,
            mode: 'INDEPENDENT',
            providerId: null,
            independentDriverProfileId: actor.profileId,
            driverId: actor.driverId,
            vehicleId,
            assignedAt: now,
            assignedByUserId: userId,
          },
          select: { id: true },
        });
        // Charged last, with the claim and the assignment already written in this transaction: the
        // guard in PostgreSQL only accepts a charge from the driver holding the dispatch, and a
        // rejection here rolls back the take, the assignment and the debit together.
        const award = await chargeDispatchAward(
          tx,
          { id: dispatchId, creditMode: dispatch.creditMode },
          {
            actorType: 'INDEPENDENT_DRIVER',
            independentDriverProfileId: actor.profileId,
          },
          userId,
        );
        return { kind: 'taken' as const, assignmentId: assignment.id, award };
      }),
    );
    if (outcome.kind === 'expired') {
      this.logger.log({
        event: 'DISPATCH_EXPIRED',
        dispatchId,
        driverId: actor.driverId,
        actorUserId: userId,
        reason: 'TAKE_AFTER_WINDOW',
      });
      throw independentError(
        'DISPATCH_EXPIRED',
        REJECTION_MESSAGES.DISPATCH_EXPIRED,
      );
    }
    this.logger.log({
      event: 'INDEPENDENT_DISPATCH_TAKEN',
      dispatchId,
      assignmentId: outcome.assignmentId,
      profileId: actor.profileId,
      driverId: actor.driverId,
      vehicleId,
      actorUserId: userId,
    });
    this.logAward(outcome.award, {
      dispatchId,
      profileId: actor.profileId,
      driverId: actor.driverId,
      actorUserId: userId,
    });
    return this.viewFor(actor.driverId, dispatchId);
  }

  /**
   * The driver gives the service back (§35-§37). Single transaction: the ACTIVE assignment ends as
   * CANCELLED with the motive, the independent claim is cleared and the dispatch reopens for
   * whoever may take it — a provider candidate or another independent. After the window it becomes
   * EXPIRED instead, exactly like the V1.7 provider release. The assignment must end before the
   * dispatch leaves CLAIMED: dispatch_guard rejects the opposite order in SQL.
   * There is no reassignment for drivers (§38): releasing is the only way out.
   */
  async release(
    userId: string,
    dispatchId: string,
    input: { reason: IndependentReleaseReason; reasonDetail?: string },
  ) {
    const actor = await this.approvedDriver(this.prisma, userId);
    const outcome = await this.prisma.$transaction(async (tx) => {
      const dispatch = await this.lock(tx, dispatchId);
      if (
        dispatch.status !== 'CLAIMED' ||
        dispatch.claimedByIndependentDriverId !== actor.driverId
      )
        throw independentError(
          'DISPATCH_NOT_CLAIMED_BY_DRIVER',
          'Dispatch is not currently taken by this driver',
        );
      const now = new Date();
      const [active] = await tx.$queryRaw<
        { id: string; vehicleId: string }[]
      >`SELECT id, "vehicleId" FROM "DeliveryAssignment" WHERE "dispatchId" = ${dispatchId}::uuid AND status = 'ACTIVE' FOR UPDATE`;
      if (active)
        await tx.deliveryAssignment.update({
          where: { id: active.id },
          data: {
            status: 'CANCELLED',
            endedAt: now,
            endedByUserId: userId,
            endReason: RELEASE_END_REASON[
              input.reason
            ] as DeliveryAssignmentEndReason,
            // The driver's own motive is kept verbatim; OTHER already requires a detail.
            endReasonDetail:
              input.reasonDetail ?? `INDEPENDENT_${input.reason}`,
          },
        });
      const expired = now >= dispatch.expiresAt;
      await tx.dispatch.update({
        where: { id: dispatchId },
        data: {
          status: expired ? 'EXPIRED' : 'OPEN',
          claimedByIndependentDriverId: null,
          claimedAt: null,
          ...(expired ? { expiredAt: now } : {}),
        },
      });
      return {
        expired,
        assignmentId: active?.id ?? null,
        vehicleId: active?.vehicleId ?? null,
      };
    });
    this.logger.log({
      event: 'INDEPENDENT_DISPATCH_RELEASED',
      dispatchId,
      assignmentId: outcome.assignmentId,
      profileId: actor.profileId,
      driverId: actor.driverId,
      vehicleId: outcome.vehicleId,
      actorUserId: userId,
      reason: input.reason,
    });
    if (outcome.expired)
      this.logger.log({
        event: 'DISPATCH_EXPIRED',
        dispatchId,
        driverId: actor.driverId,
        actorUserId: userId,
        reason: 'RELEASED_AFTER_WINDOW',
      });
    return this.viewFor(actor.driverId, dispatchId);
  }

  /**
   * Maps a unique-index violation or a guard rejection (neither should happen under the locks) to
   * a clean 409. A PostgreSQL trigger firing is still a lost race, not an internal failure, so it
   * must never reach the client as a 500.
   */
  private async transaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    try {
      return await this.prisma.$transaction(fn);
    } catch (error) {
      // An economic rejection (insufficient credits, missing account or snapshot) is a final
      // answer decided under the locks, not a lost race: it keeps its own code.
      if (error instanceof DomainException) throw error;
      if (isUniqueViolation(error))
        throw independentError(
          'TAKE_CONFLICT',
          'Dispatch, driver or vehicle already has an active assignment',
        );
      if (isGuardRejection(error))
        throw independentError(
          'TAKE_CONFLICT',
          'The dispatch or the independent driver changed while taking the service',
        );
      throw error;
    }
  }

  /**
   * Resolves the authenticated user to its Driver and APPROVED independent profile. A DRIVER
   * without the capability gets 409, never a silent empty result: the driver must know whether
   * Mandaria has enabled them (§5). Nothing here trusts an id sent by the client.
   */
  private async approvedDriver(
    db: Prisma.TransactionClient | PrismaService,
    userId: string,
  ): Promise<ApprovedDriver> {
    const driver = await db.driver.findUnique({
      where: { userId },
      select: {
        id: true,
        status: true,
        independentProfile: { select: { id: true, status: true } },
      },
    });
    if (!driver) throw new NotFoundException('Driver profile not found');
    if (!driver.independentProfile)
      throw independentError(
        'INDEPENDENT_NOT_APPROVED',
        'This driver is not enabled as an independent driver',
      );
    if (driver.independentProfile.status !== 'APPROVED')
      throw independentError(
        'INDEPENDENT_NOT_APPROVED',
        `Independent driver profile is ${driver.independentProfile.status}`,
      );
    return { driverId: driver.id, profileId: driver.independentProfile.id };
  }

  /**
   * Under the dispatch lock: the driver is operational and free, and the vehicle is one of its
   * own, ACTIVE and free. Ownership is re-read from the database (§9) — a vehicleId belonging to a
   * provider or to another independent driver is reported as 404, so ids cannot be probed. The
   * busy checks look at every ACTIVE assignment regardless of mode, which is what makes a driver
   * or a vehicle busy in one model unavailable in the other.
   *
   * The IndependentDriverProfile row is locked together with the Driver row, and that is what
   * makes taking a service and withdrawing the capability mutually exclusive: suspension locks the
   * same profile row. Without it the two transactions never met, and a suspension could commit
   * between this check and the assignment insert, leaving a SUSPENDED driver executing a service.
   * Lock order is dispatch -> profile+driver -> vehicle; suspension only ever takes the profile
   * lock, so no cycle is possible.
   */
  private async lockEligibleResources(
    tx: Prisma.TransactionClient,
    actor: ApprovedDriver,
    vehicleId: string,
  ) {
    const [driver] = await tx.$queryRaw<
      {
        status: string;
        userActive: boolean;
        profileStatus: IndependentDriverStatus;
      }[]
    >`SELECT d.status, u.active AS "userActive", p.status AS "profileStatus" FROM "Driver" d JOIN "User" u ON u.id = d."userId" JOIN "IndependentDriverProfile" p ON p."driverId" = d.id WHERE d.id = ${actor.driverId}::uuid FOR UPDATE OF d, p`;
    if (!driver) throw new NotFoundException('Driver profile not found');
    if (driver.status !== 'ACTIVE' || !driver.userActive)
      throw independentError(
        'DRIVER_NOT_ELIGIBLE',
        'Driver must be ACTIVE with an active account',
      );
    if (driver.profileStatus !== 'APPROVED')
      throw independentError(
        'INDEPENDENT_NOT_APPROVED',
        `Independent driver profile is ${driver.profileStatus}`,
      );
    const [vehicle] = await tx.$queryRaw<
      { status: VehicleStatus }[]
    >`SELECT status FROM "Vehicle" WHERE id = ${vehicleId}::uuid AND "independentDriverProfileId" = ${actor.profileId}::uuid FOR UPDATE`;
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    if (vehicle.status !== 'ACTIVE')
      throw independentError('VEHICLE_NOT_ELIGIBLE', 'Vehicle must be ACTIVE');
    const busy = await tx.deliveryAssignment.findMany({
      where: {
        status: 'ACTIVE',
        OR: [{ driverId: actor.driverId }, { vehicleId }],
      },
      select: { driverId: true, vehicleId: true },
    });
    if (busy.some((a) => a.driverId === actor.driverId))
      throw independentError(
        'DRIVER_BUSY',
        'Driver already has an active delivery assignment',
      );
    if (busy.some((a) => a.vehicleId === vehicleId))
      throw independentError(
        'VEHICLE_BUSY',
        'Vehicle already has an active delivery assignment',
      );
  }

  /** Same row lock the provider claim takes, so both execution models compete fairly. */
  /** One line per economic outcome of a take: charged, or skipped because the dispatch is legacy. */
  private logAward(
    award: AwardOutcome,
    context: {
      dispatchId: string;
      profileId: string;
      driverId: string;
      actorUserId: string;
    },
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

  /** Reports why a take was refused for economic reasons; the rejection itself is the answer. */
  private async charging<T>(
    context: { dispatchId: string; driverId: string; actorUserId: string },
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

  private async lock(tx: Prisma.TransactionClient, dispatchId: string) {
    const [row] = await tx.$queryRaw<
      LockedDispatch[]
    >`SELECT d.id, d.status, d."expiresAt", d."claimedByProviderId", d."claimedByIndependentDriverId", d."creditMode", d."claimedAt", q."serviceType" FROM "Dispatch" d JOIN "DeliveryQuote" q ON q.id = d."deliveryQuoteId" WHERE d.id = ${dispatchId}::uuid FOR UPDATE OF d`;
    if (!row) throw new NotFoundException('Dispatch not found');
    return row;
  }
}

const REJECTION_MESSAGES: Record<TakeRejectionCode, string> = {
  DISPATCH_EXPIRED: 'Dispatch window has closed',
  DISPATCH_CANCELLED: 'Dispatch was cancelled',
  DISPATCH_ALREADY_CLAIMED:
    'Dispatch was already taken by a provider or another driver',
  DISPATCH_NOT_OPEN_TO_INDEPENDENT:
    'This service type is not available to independent drivers',
  DISPATCH_RETAKE_NOT_ALLOWED:
    'This driver released the dispatch and cannot take it again',
};
