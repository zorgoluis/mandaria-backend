import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { DriverStatus, VehicleStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { PaginationQueryDto, pageResult } from '../common/pagination.dto.js';
import {
  isUniqueViolation,
  lockProvider,
} from '../providers/provider-capacity.js';
import { assignmentHistorySelect } from './assignment.select.js';

const busy = (subject: 'Driver' | 'Vehicle') =>
  new ConflictException(
    subject === 'Driver'
      ? 'Driver already has an active vehicle assignment'
      : 'Vehicle is already assigned to another driver',
  );

/**
 * V1.8: the vehicle a driver operates cannot change while either of them is executing a delivery
 * assignment; the provider must end that assignment first.
 */
async function assertNoDeliveryAssignment(
  tx: Prisma.TransactionClient,
  resources: { driverId: string; vehicleId?: string },
) {
  const active = await tx.deliveryAssignment.findFirst({
    where: {
      status: 'ACTIVE',
      OR: [
        { driverId: resources.driverId },
        ...(resources.vehicleId ? [{ vehicleId: resources.vehicleId }] : []),
      ],
    },
    select: { id: true },
  });
  if (active)
    throw new ConflictException(
      'Driver or vehicle is executing a delivery assignment',
    );
}

@Injectable()
export class AssignmentsService {
  private readonly logger = new Logger(AssignmentsService.name);
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Opens an assignment. Locks provider (share) → driver → vehicle, so concurrent
   * assign/unassign/status changes on the same rows are serialized; the partial unique
   * indexes remain the last line of defence. Both lookups are scoped by providerId, so a
   * vehicle of another provider is indistinguishable from a missing one (404).
   */
  async assign(
    providerId: string,
    driverId: string,
    vehicleId: string,
    actorId: string,
  ) {
    try {
      const assignment = await this.prisma.$transaction(async (tx) => {
        const provider = await lockProvider(tx, providerId, 'SHARE');
        const [driver] = await tx.$queryRaw<
          { status: DriverStatus }[]
        >`SELECT status FROM "Driver" WHERE id = ${driverId}::uuid AND "providerId" = ${providerId}::uuid FOR UPDATE`;
        if (!driver) throw new NotFoundException('Driver not found');
        const [vehicle] = await tx.$queryRaw<
          { status: VehicleStatus }[]
        >`SELECT status FROM "Vehicle" WHERE id = ${vehicleId}::uuid AND "providerId" = ${providerId}::uuid FOR UPDATE`;
        if (!vehicle) throw new NotFoundException('Vehicle not found');
        if (provider.status === 'SUSPENDED')
          throw new ConflictException(
            'Suspended providers cannot assign vehicles',
          );
        if (driver.status === 'SUSPENDED')
          throw new ConflictException(
            'Suspended drivers cannot receive vehicles',
          );
        if (vehicle.status !== 'ACTIVE')
          throw new ConflictException('Only ACTIVE vehicles can be assigned');
        const active = await tx.driverVehicleAssignment.findMany({
          where: {
            unassignedAt: null,
            OR: [{ driverId }, { vehicleId }],
          },
          select: { driverId: true },
        });
        if (active.some((a) => a.driverId === driverId)) throw busy('Driver');
        if (active.length) throw busy('Vehicle');
        await assertNoDeliveryAssignment(tx, { driverId, vehicleId });
        return tx.driverVehicleAssignment.create({
          data: { providerId, driverId, vehicleId },
          select: assignmentHistorySelect,
        });
      });
      this.logger.log({
        event: 'VEHICLE_ASSIGNED',
        providerId,
        driverId,
        vehicleId,
        assignmentId: assignment.id,
        actorId,
      });
      return assignment;
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException('Driver or vehicle already assigned');
      throw error;
    }
  }

  /** Closes the driver's active assignment; the row is kept as history. */
  async unassign(providerId: string, driverId: string, actorId: string) {
    const assignment = await this.prisma.$transaction(async (tx) => {
      const [driver] = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "Driver" WHERE id = ${driverId}::uuid AND "providerId" = ${providerId}::uuid FOR UPDATE`;
      if (!driver) throw new NotFoundException('Driver not found');
      const active = await tx.driverVehicleAssignment.findFirst({
        where: { driverId, unassignedAt: null },
        select: { id: true, assignedAt: true },
      });
      if (!active)
        throw new NotFoundException('Driver has no active vehicle assignment');
      await assertNoDeliveryAssignment(tx, { driverId });
      const now = new Date();
      return tx.driverVehicleAssignment.update({
        where: { id: active.id },
        // Guards the period CHECK against small clock adjustments.
        data: {
          unassignedAt: now < active.assignedAt ? active.assignedAt : now,
        },
        select: assignmentHistorySelect,
      });
    });
    this.logger.log({
      event: 'VEHICLE_UNASSIGNED',
      providerId,
      driverId,
      vehicleId: assignment.vehicleId,
      assignmentId: assignment.id,
      actorId,
    });
    return assignment;
  }

  async history(
    providerId: string,
    subject: { driverId: string } | { vehicleId: string },
    query: PaginationQueryDto,
  ) {
    const exists =
      'driverId' in subject
        ? await this.prisma.driver.findFirst({
            where: { id: subject.driverId, providerId },
            select: { id: true },
          })
        : await this.prisma.vehicle.findFirst({
            where: { id: subject.vehicleId, providerId },
            select: { id: true },
          });
    if (!exists)
      throw new NotFoundException(
        'driverId' in subject ? 'Driver not found' : 'Vehicle not found',
      );
    const where = { providerId, ...subject };
    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.driverVehicleAssignment.findMany({
          where,
          select: assignmentHistorySelect,
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
        }),
        this.prisma.driverVehicleAssignment.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return pageResult(items, total, query);
  }
}
