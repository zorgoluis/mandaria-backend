import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { IndependentDriverStatus, VehicleStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { pageResult } from '../common/pagination.dto.js';
import { isUniqueViolation } from '../providers/provider-capacity.js';
import { independentError } from './independent-driver-policy.js';
import {
  independentProfileSelect,
  independentVehicleSelect,
} from './independent-drivers.select.js';
import type {
  CreateIndependentVehicleDto,
  UpdateIndependentVehicleDto,
} from './independent-drivers.dto.js';

type Actor = { userId: string };

@Injectable()
export class IndependentDriversService {
  private readonly logger = new Logger(IndependentDriversService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * SUPER_ADMIN enables an existing Driver to also operate for itself. V1.9 has no public
   * onboarding, so the profile is created straight in APPROVED (PENDING stays reserved for a
   * future self-registration). Re-approving a SUSPENDED or REJECTED profile is the documented way
   * to reinstate a driver; approving an already APPROVED one is idempotent and changes nothing.
   * No User or Driver is ever created here: provisioning stays in V1.6.1.
   */
  async approve(driverId: string, reason: string | undefined, actor: Actor) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const driver = await this.eligibleDriver(tx, driverId);
      const now = new Date();
      const existing = await tx.independentDriverProfile.findUnique({
        where: { driverId },
        select: { id: true, status: true },
      });
      if (existing?.status === 'APPROVED')
        return { profileId: existing.id, changed: false, driver };
      const data = {
        status: 'APPROVED' as const,
        approvedAt: now,
        approvedByUserId: actor.userId,
        // A new approval closes the previous suspension or rejection.
        suspendedAt: null,
        suspendedByUserId: null,
        rejectedAt: null,
        rejectedByUserId: null,
        reason: reason ?? null,
      };
      const profile = existing
        ? await tx.independentDriverProfile.update({
            where: { id: existing.id },
            data,
            select: { id: true },
          })
        : await tx.independentDriverProfile.create({
            data: { driverId, ...data },
            select: { id: true },
          });
      return { profileId: profile.id, changed: true, driver };
    });
    if (outcome.changed)
      this.logger.log({
        event: 'INDEPENDENT_DRIVER_ENABLED',
        profileId: outcome.profileId,
        driverId,
        actorUserId: actor.userId,
      });
    return this.getByDriver(driverId);
  }

  /**
   * Withdraws the capability. V1.9 refuses the suspension while the driver is executing a service
   * (§46): cancelling a delivery in progress behind the driver's back would leave the merchant and
   * the customer without an explanation, so an operator must end the service explicitly first.
   * The same rule is enforced by independent_driver_profile_guard in PostgreSQL.
   */
  async suspend(driverId: string, reason: string, actor: Actor) {
    return this.close(driverId, 'SUSPENDED', reason, actor);
  }

  /** Closes an application without deleting history; same active-service rule as suspension. */
  async reject(driverId: string, reason: string, actor: Actor) {
    return this.close(driverId, 'REJECTED', reason, actor);
  }

  private async close(
    driverId: string,
    status: 'SUSPENDED' | 'REJECTED',
    reason: string,
    actor: Actor,
  ) {
    const profileId = await this.prisma.$transaction(async (tx) => {
      const profile = await this.lockProfile(tx, driverId);
      if (profile.status === status) return profile.id;
      if (
        await tx.deliveryAssignment.findFirst({
          where: { independentDriverProfileId: profile.id, status: 'ACTIVE' },
          select: { id: true },
        })
      )
        throw independentError(
          'INDEPENDENT_DRIVER_HAS_ACTIVE_ASSIGNMENT',
          'The driver is executing a service; end that delivery assignment before suspending',
        );
      const now = new Date();
      await tx.independentDriverProfile.update({
        where: { id: profile.id },
        data:
          status === 'SUSPENDED'
            ? {
                status,
                suspendedAt: now,
                suspendedByUserId: actor.userId,
                reason,
              }
            : {
                status,
                rejectedAt: now,
                rejectedByUserId: actor.userId,
                reason,
              },
      });
      return profile.id;
    });
    this.logger.log({
      event:
        status === 'SUSPENDED'
          ? 'INDEPENDENT_DRIVER_SUSPENDED'
          : 'INDEPENDENT_DRIVER_REJECTED',
      profileId,
      driverId,
      actorUserId: actor.userId,
      reason,
    });
    return this.getByDriver(driverId);
  }

  async list(query: {
    page: number;
    pageSize: number;
    status?: IndependentDriverStatus;
  }) {
    const where: Prisma.IndependentDriverProfileWhereInput = query.status
      ? { status: query.status }
      : {};
    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.independentDriverProfile.findMany({
          where,
          select: independentProfileSelect,
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
        this.prisma.independentDriverProfile.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return pageResult(items, total, query);
  }

  async getByDriver(driverId: string) {
    const profile = await this.prisma.independentDriverProfile.findUnique({
      where: { driverId },
      select: independentProfileSelect,
    });
    if (!profile)
      throw new NotFoundException('Independent driver profile not found');
    return profile;
  }

  /**
   * Vehicles of the independent driver: owned by the profile, never by a provider. The owner is
   * derived from the route, never from the payload, so a vehicle cannot be created under someone
   * else. Documentary onboarding of the vehicle is out of scope in V1.9.
   */
  async createVehicle(
    driverId: string,
    dto: CreateIndependentVehicleDto,
    actor: Actor,
  ) {
    const max = this.config.getOrThrow<number>(
      'INDEPENDENT_DRIVER_MAX_VEHICLES',
    );
    try {
      const vehicle = await this.prisma.$transaction(async (tx) => {
        const profile = await this.lockProfile(tx, driverId);
        // Every vehicle counts whatever its status: V1.9 does not delete vehicles either.
        if (
          (await tx.vehicle.count({
            where: { independentDriverProfileId: profile.id },
          })) >= max
        )
          throw independentError(
            'VEHICLE_LIMIT_REACHED',
            `Independent driver vehicle limit reached (${max})`,
          );
        return tx.vehicle.create({
          data: {
            ...dto,
            providerId: null,
            independentDriverProfileId: profile.id,
          },
          select: independentVehicleSelect,
        });
      });
      this.logger.log({
        event: 'INDEPENDENT_VEHICLE_CREATED',
        driverId,
        vehicleId: vehicle.id,
        actorUserId: actor.userId,
      });
      return vehicle;
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException(
          'Vehicle identifier already exists for this independent driver',
        );
      throw error;
    }
  }

  async listVehicles(driverId: string) {
    const profile = await this.getByDriver(driverId);
    return this.prisma.vehicle.findMany({
      where: { independentDriverProfileId: profile.id },
      select: independentVehicleSelect,
      orderBy: [{ identifier: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Editing details and status. Deactivating a vehicle that is executing a service is refused for
   * the same reason as suspending its driver (§47): the operation would leave a delivery in
   * progress pointing at an unusable vehicle.
   */
  async updateVehicle(
    driverId: string,
    vehicleId: string,
    dto: UpdateIndependentVehicleDto,
    actor: Actor,
  ) {
    if (!dto || !Object.values(dto).some((value) => value !== undefined))
      throw new BadRequestException('At least one editable field is required');
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const profile = await this.lockProfile(tx, driverId);
        const [previous] = await tx.$queryRaw<
          { status: VehicleStatus }[]
        >`SELECT status FROM "Vehicle" WHERE id = ${vehicleId}::uuid AND "independentDriverProfileId" = ${profile.id}::uuid FOR UPDATE`;
        if (!previous) throw new NotFoundException('Vehicle not found');
        if (
          dto.status !== undefined &&
          dto.status !== 'ACTIVE' &&
          previous.status === 'ACTIVE' &&
          (await tx.deliveryAssignment.findFirst({
            where: { vehicleId, status: 'ACTIVE' },
            select: { id: true },
          }))
        )
          throw independentError(
            'VEHICLE_HAS_ACTIVE_ASSIGNMENT',
            'The vehicle is executing a service; end that delivery assignment first',
          );
        const vehicle = await tx.vehicle.update({
          where: { id: vehicleId },
          data: dto,
          select: independentVehicleSelect,
        });
        return { vehicle, from: previous.status };
      });
      const ids = { driverId, vehicleId, actorUserId: actor.userId };
      const { status, ...details } = dto;
      if (Object.values(details).some((value) => value !== undefined))
        this.logger.log({ event: 'INDEPENDENT_VEHICLE_UPDATED', ...ids });
      if (status !== undefined && status !== result.from)
        this.logger.log({
          event: 'INDEPENDENT_VEHICLE_STATUS_CHANGED',
          ...ids,
          from: result.from,
          to: status,
        });
      return result.vehicle;
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException(
          'Vehicle identifier already exists for this independent driver',
        );
      throw error;
    }
  }

  /** Only a real, operational Driver of an active account may become independent (§6). */
  private async eligibleDriver(tx: Prisma.TransactionClient, driverId: string) {
    const driver = await tx.driver.findUnique({
      where: { id: driverId },
      select: {
        id: true,
        name: true,
        status: true,
        user: { select: { id: true, active: true, role: true } },
      },
    });
    if (!driver) throw new NotFoundException('Driver not found');
    if (
      driver.status !== 'ACTIVE' ||
      !driver.user.active ||
      driver.user.role !== 'DRIVER'
    )
      throw independentError(
        'DRIVER_NOT_ELIGIBLE',
        'Driver must be ACTIVE with an active account and the DRIVER role',
      );
    return driver;
  }

  private async lockProfile(tx: Prisma.TransactionClient, driverId: string) {
    const [row] = await tx.$queryRaw<
      { id: string; status: IndependentDriverStatus }[]
    >`SELECT id, status FROM "IndependentDriverProfile" WHERE "driverId" = ${driverId}::uuid FOR UPDATE`;
    if (!row)
      throw new NotFoundException('Independent driver profile not found');
    return row;
  }
}
