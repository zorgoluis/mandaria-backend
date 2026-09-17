import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  DeliveryAssignmentEndReason,
  DispatchStatus,
  DriverStatus,
  VehicleStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { pageResult } from '../common/pagination.dto.js';
import {
  isUniqueViolation,
  lockProvider,
} from '../providers/provider-capacity.js';
import {
  assignmentError,
  pairingConflict,
  paymentContext,
} from './assignment-policy.js';
import type { ProviderEndReason } from './assignment-policy.js';

export const deliveryAssignmentSelect = {
  id: true,
  dispatchId: true,
  providerId: true,
  status: true,
  assignedAt: true,
  assignedByUserId: true,
  endedAt: true,
  endedByUserId: true,
  endReason: true,
  endReasonDetail: true,
  driver: { select: { id: true, name: true } },
  vehicle: {
    select: { id: true, identifier: true, type: true, plate: true },
  },
} satisfies Prisma.DeliveryAssignmentSelect;

type Resources = { driverId: string; vehicleId: string };
type EndInput = { reason: ProviderEndReason; reasonDetail?: string };
type Actor = { providerId: string; userId: string };

@Injectable()
export class DeliveryAssignmentsService {
  private readonly logger = new Logger(DeliveryAssignmentsService.name);
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Assigns a driver and vehicle of the claim owner. Locks, in this order, the dispatch row (one
   * writer per dispatch), the provider (share), the driver and the vehicle rows (one writer per
   * resource across dispatches). Every check runs under those locks; the partial unique indexes
   * on ACTIVE rows (dispatch, driver, vehicle) back them up in PostgreSQL.
   */
  async create(dispatchId: string, input: Resources, actor: Actor) {
    const assignment = await this.transaction(async (tx) => {
      await this.lockOwnedDispatch(tx, dispatchId, actor.providerId);
      if (await this.activeFor(tx, dispatchId))
        throw assignmentError(
          'DISPATCH_ALREADY_ASSIGNED',
          'Dispatch already has an active assignment; reassign it instead',
        );
      await this.lockEligibleResources(tx, actor.providerId, input);
      return tx.deliveryAssignment.create({
        data: {
          dispatchId,
          providerId: actor.providerId,
          ...input,
          assignedAt: new Date(),
          assignedByUserId: actor.userId,
        },
        select: deliveryAssignmentSelect,
      });
    });
    this.logger.log({
      event: 'DELIVERY_ASSIGNMENT_CREATED',
      assignmentId: assignment.id,
      dispatchId,
      providerId: actor.providerId,
      driverId: input.driverId,
      vehicleId: input.vehicleId,
      actorUserId: actor.userId,
    });
    return this.withPaymentContext(dispatchId, assignment);
  }

  /**
   * Atomic replacement: the ACTIVE row becomes REASSIGNED and a new ACTIVE row is inserted in the
   * same transaction, so there is never zero-by-failure or two ACTIVE assignments. Reassigning to
   * the exact same driver and vehicle is rejected (ASSIGNMENT_UNCHANGED): it would only add noise
   * to the history.
   */
  async reassign(
    dispatchId: string,
    input: Resources & EndInput,
    actor: Actor,
  ) {
    const outcome = await this.transaction(async (tx) => {
      await this.lockOwnedDispatch(tx, dispatchId, actor.providerId);
      const previous = await this.lockActive(tx, dispatchId);
      if (
        previous.driverId === input.driverId &&
        previous.vehicleId === input.vehicleId
      )
        throw assignmentError(
          'ASSIGNMENT_UNCHANGED',
          'The active assignment already uses this driver and vehicle',
        );
      const now = new Date();
      await tx.deliveryAssignment.update({
        where: { id: previous.id },
        data: {
          status: 'REASSIGNED',
          endedAt: now,
          endedByUserId: actor.userId,
          endReason: input.reason,
          endReasonDetail: input.reasonDetail ?? null,
        },
      });
      // Eligibility after ending the previous row: keeping the same driver or vehicle is allowed.
      await this.lockEligibleResources(tx, actor.providerId, input);
      const assignment = await tx.deliveryAssignment.create({
        data: {
          dispatchId,
          providerId: actor.providerId,
          driverId: input.driverId,
          vehicleId: input.vehicleId,
          assignedAt: now,
          assignedByUserId: actor.userId,
        },
        select: deliveryAssignmentSelect,
      });
      return { previous, assignment };
    });
    this.logger.log({
      event: 'DELIVERY_ASSIGNMENT_REASSIGNED',
      previousAssignmentId: outcome.previous.id,
      assignmentId: outcome.assignment.id,
      dispatchId,
      providerId: actor.providerId,
      previousDriverId: outcome.previous.driverId,
      previousVehicleId: outcome.previous.vehicleId,
      driverId: input.driverId,
      vehicleId: input.vehicleId,
      actorUserId: actor.userId,
      reason: input.reason,
    });
    return this.withPaymentContext(dispatchId, outcome.assignment);
  }

  /** Ends the ACTIVE assignment without a replacement (e.g. before releasing the dispatch). */
  async cancel(dispatchId: string, input: EndInput, actor: Actor) {
    const assignment = await this.transaction(async (tx) => {
      await this.lockOwnedDispatch(tx, dispatchId, actor.providerId);
      const active = await this.lockActive(tx, dispatchId);
      return tx.deliveryAssignment.update({
        where: { id: active.id },
        data: {
          status: 'CANCELLED',
          endedAt: new Date(),
          endedByUserId: actor.userId,
          endReason: input.reason,
          endReasonDetail: input.reasonDetail ?? null,
        },
        select: deliveryAssignmentSelect,
      });
    });
    this.logger.log({
      event: 'DELIVERY_ASSIGNMENT_CANCELLED',
      assignmentId: assignment.id,
      dispatchId,
      providerId: actor.providerId,
      driverId: assignment.driver.id,
      vehicleId: assignment.vehicle.id,
      actorUserId: actor.userId,
      reason: input.reason,
    });
    return this.withPaymentContext(dispatchId, assignment);
  }

  /** History of this provider's assignments on a dispatch it was offered (newest first). */
  async historyForProvider(dispatchId: string, providerId: string) {
    const offered = await this.prisma.dispatchCandidate.findUnique({
      where: { dispatchId_providerId: { dispatchId, providerId } },
      select: { id: true },
    });
    if (!offered) throw new NotFoundException('Dispatch not found');
    return this.prisma.deliveryAssignment.findMany({
      where: { dispatchId, providerId },
      select: deliveryAssignmentSelect,
      orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
    });
  }

  async historyForAdmin(dispatchId: string) {
    if (
      !(await this.prisma.dispatch.findUnique({
        where: { id: dispatchId },
        select: { id: true },
      }))
    )
      throw new NotFoundException('Dispatch not found');
    return this.prisma.deliveryAssignment.findMany({
      where: { dispatchId },
      select: {
        ...deliveryAssignmentSelect,
        provider: { select: { id: true, name: true, code: true } },
      },
      orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
    });
  }

  /**
   * Drivers the claim owner could assign now: its own, ACTIVE, with an active user and without an
   * ACTIVE delivery assignment. Online/GPS status is not required in V1.8. The current V1.4
   * vehicle pairing is included because the assigned vehicle must match it.
   */
  async availableDrivers(
    dispatchId: string,
    providerId: string,
    query: { page: number; pageSize: number },
  ) {
    await this.requireOwnedDispatch(dispatchId, providerId);
    const where: Prisma.DriverWhereInput = {
      providerId,
      status: 'ACTIVE',
      user: { active: true },
      deliveryAssignments: { none: { status: 'ACTIVE' } },
    };
    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.driver.findMany({
          where,
          select: {
            id: true,
            name: true,
            availability: true,
            assignments: {
              where: { unassignedAt: null },
              take: 1,
              select: {
                vehicle: {
                  select: {
                    id: true,
                    identifier: true,
                    type: true,
                    status: true,
                  },
                },
              },
            },
          },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
        }),
        this.prisma.driver.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return pageResult(
      items.map(({ assignments, ...driver }) => ({
        ...driver,
        pairedVehicle: assignments[0]?.vehicle ?? null,
      })),
      total,
      query,
    );
  }

  /** Vehicles the claim owner could assign now: its own, ACTIVE, without an ACTIVE assignment. */
  async availableVehicles(
    dispatchId: string,
    providerId: string,
    query: { page: number; pageSize: number },
  ) {
    await this.requireOwnedDispatch(dispatchId, providerId);
    const where: Prisma.VehicleWhereInput = {
      providerId,
      status: 'ACTIVE',
      deliveryAssignments: { none: { status: 'ACTIVE' } },
    };
    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.vehicle.findMany({
          where,
          select: {
            id: true,
            identifier: true,
            type: true,
            brand: true,
            model: true,
            color: true,
            plate: true,
            assignments: {
              where: { unassignedAt: null },
              take: 1,
              select: { driver: { select: { id: true, name: true } } },
            },
          },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          orderBy: [{ identifier: 'asc' }, { id: 'asc' }],
        }),
        this.prisma.vehicle.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return pageResult(
      items.map(({ assignments, ...vehicle }) => ({
        ...vehicle,
        pairedDriver: assignments[0]?.driver ?? null,
      })),
      total,
      query,
    );
  }

  /** Maps a unique-index violation (should not happen under the locks) to a clean 409. */
  private async transaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    try {
      return await this.prisma.$transaction(fn);
    } catch (error) {
      if (isUniqueViolation(error))
        throw assignmentError(
          'ASSIGNMENT_CONFLICT',
          'Dispatch, driver or vehicle already has an active assignment',
        );
      throw error;
    }
  }

  /** 404 unless the provider was a candidate; 409 unless it currently holds the claim. */
  private async lockOwnedDispatch(
    tx: Prisma.TransactionClient,
    dispatchId: string,
    providerId: string,
  ) {
    const [row] = await tx.$queryRaw<
      { status: DispatchStatus; claimedByProviderId: string | null }[]
    >`SELECT d.status, d."claimedByProviderId" FROM "Dispatch" d WHERE d.id = ${dispatchId}::uuid AND EXISTS (SELECT 1 FROM "DispatchCandidate" c WHERE c."dispatchId" = d.id AND c."providerId" = ${providerId}::uuid) FOR UPDATE OF d`;
    if (!row) throw new NotFoundException('Dispatch not found');
    if (row.status !== 'CLAIMED' || row.claimedByProviderId !== providerId)
      throw assignmentError(
        'DISPATCH_NOT_CLAIMED_BY_PROVIDER',
        'Dispatch is not currently claimed by this provider',
      );
    return row;
  }

  private async requireOwnedDispatch(dispatchId: string, providerId: string) {
    const dispatch = await this.prisma.dispatch.findFirst({
      where: { id: dispatchId, candidates: { some: { providerId } } },
      select: { status: true, claimedByProviderId: true },
    });
    if (!dispatch) throw new NotFoundException('Dispatch not found');
    if (
      dispatch.status !== 'CLAIMED' ||
      dispatch.claimedByProviderId !== providerId
    )
      throw assignmentError(
        'DISPATCH_NOT_CLAIMED_BY_PROVIDER',
        'Dispatch is not currently claimed by this provider',
      );
  }

  private activeFor(tx: Prisma.TransactionClient, dispatchId: string) {
    return tx.deliveryAssignment.findFirst({
      where: { dispatchId, status: 'ACTIVE' },
      select: { id: true },
    });
  }

  private async lockActive(tx: Prisma.TransactionClient, dispatchId: string) {
    const [row] = await tx.$queryRaw<
      { id: string; driverId: string; vehicleId: string }[]
    >`SELECT id, "driverId", "vehicleId" FROM "DeliveryAssignment" WHERE "dispatchId" = ${dispatchId}::uuid AND status = 'ACTIVE' FOR UPDATE`;
    if (!row)
      throw assignmentError(
        'NO_ACTIVE_ASSIGNMENT',
        'Dispatch has no active assignment',
      );
    return row;
  }

  /**
   * Provider ACTIVE; driver and vehicle of that provider (else 404, even if they exist elsewhere),
   * operational, free of ACTIVE delivery assignments and consistent with the V1.4 pairing.
   */
  private async lockEligibleResources(
    tx: Prisma.TransactionClient,
    providerId: string,
    { driverId, vehicleId }: Resources,
  ) {
    const provider = await lockProvider(tx, providerId, 'SHARE');
    const [driver] = await tx.$queryRaw<
      { status: DriverStatus; userActive: boolean }[]
    >`SELECT d.status, u.active AS "userActive" FROM "Driver" d JOIN "User" u ON u.id = d."userId" WHERE d.id = ${driverId}::uuid AND d."providerId" = ${providerId}::uuid FOR UPDATE OF d`;
    if (!driver) throw new NotFoundException('Driver not found');
    const [vehicle] = await tx.$queryRaw<
      { status: VehicleStatus }[]
    >`SELECT status FROM "Vehicle" WHERE id = ${vehicleId}::uuid AND "providerId" = ${providerId}::uuid FOR UPDATE`;
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    if (provider.status !== 'ACTIVE')
      throw assignmentError(
        'PROVIDER_NOT_ACTIVE',
        'Provider must be ACTIVE to assign resources',
      );
    if (driver.status !== 'ACTIVE' || !driver.userActive)
      throw assignmentError(
        'DRIVER_NOT_ELIGIBLE',
        'Driver must be ACTIVE with an active account',
      );
    if (vehicle.status !== 'ACTIVE')
      throw assignmentError('VEHICLE_NOT_ELIGIBLE', 'Vehicle must be ACTIVE');
    const busy = await tx.deliveryAssignment.findMany({
      where: { status: 'ACTIVE', OR: [{ driverId }, { vehicleId }] },
      select: { driverId: true, vehicleId: true },
    });
    if (busy.some((a) => a.driverId === driverId))
      throw assignmentError(
        'DRIVER_BUSY',
        'Driver already has an active delivery assignment',
      );
    if (busy.some((a) => a.vehicleId === vehicleId))
      throw assignmentError(
        'VEHICLE_BUSY',
        'Vehicle already has an active delivery assignment',
      );
    const pairings = await tx.driverVehicleAssignment.findMany({
      where: { unassignedAt: null, OR: [{ driverId }, { vehicleId }] },
      select: { driverId: true, vehicleId: true },
    });
    if (pairingConflict(pairings, driverId, vehicleId))
      throw assignmentError(
        'DRIVER_VEHICLE_MISMATCH',
        'Driver or vehicle is paired with another resource (V1.4 vehicle assignment)',
      );
  }

  private async withPaymentContext<T>(dispatchId: string, assignment: T) {
    const dispatch = await this.prisma.dispatch.findUniqueOrThrow({
      where: { id: dispatchId },
      select: {
        deliveryQuote: { select: { amount: true, currency: true } },
        deliveryRequest: {
          select: {
            financialContext: {
              select: {
                goodsValue: true,
                goodsPaymentMode: true,
                currency: true,
              },
            },
          },
        },
      },
    });
    return {
      ...assignment,
      paymentContext: paymentContext(
        dispatch.deliveryQuote,
        dispatch.deliveryRequest.financialContext,
      ),
    };
  }
}

/**
 * Official DeliveryRequest cancellation (inside its transaction, dispatch rows already locked):
 * ACTIVE assignments end as CANCELLED / DELIVERY_CANCELLED before the dispatch is cancelled.
 */
export async function cancelActiveAssignments(
  tx: Prisma.TransactionClient,
  dispatchIds: string[],
  now: Date,
  actorUserId: string | null,
) {
  if (!dispatchIds.length) return [];
  const active = await tx.deliveryAssignment.findMany({
    where: { dispatchId: { in: dispatchIds }, status: 'ACTIVE' },
    select: {
      id: true,
      dispatchId: true,
      providerId: true,
      driverId: true,
      vehicleId: true,
    },
  });
  const reason: DeliveryAssignmentEndReason = 'DELIVERY_CANCELLED';
  for (const assignment of active)
    await tx.deliveryAssignment.update({
      where: { id: assignment.id },
      data: {
        status: 'CANCELLED',
        endedAt: now,
        endedByUserId: actorUserId,
        endReason: reason,
      },
    });
  return active;
}
