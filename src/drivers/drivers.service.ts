import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { DriverAvailability, DriverStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { pageResult } from '../common/pagination.dto.js';
import {
  isUniqueViolation,
  lockProvider,
} from '../providers/provider-capacity.js';
import {
  CreateDriverDto,
  DriverListQueryDto,
  UpdateDriverDto,
} from './drivers.dto.js';
import { withCurrentAssignment } from '../assignments/assignment.select.js';
import { driverSelect, driverSelfSelect } from './driver.select.js';

const STATUS_TRANSITIONS: Record<DriverStatus, DriverStatus[]> = {
  PENDING: ['ACTIVE', 'SUSPENDED'],
  ACTIVE: ['SUSPENDED'],
  SUSPENDED: ['ACTIVE'],
};

@Injectable()
export class DriversService {
  private readonly logger = new Logger(DriversService.name);
  constructor(private readonly prisma: PrismaService) {}

  /** providerId must already be authorized (SUPER_ADMIN path or membership guard). */
  async create(providerId: string, dto: CreateDriverDto, actorId: string) {
    try {
      const driver = await this.prisma.$transaction(async (tx) => {
        // Provider lock first: concurrent creations for one provider are serialized,
        // so count + insert cannot exceed maxDrivers.
        const provider = await lockProvider(tx, providerId);
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${dto.userId}::uuid FOR UPDATE`;
        const user = await tx.user.findUnique({
          where: { id: dto.userId },
          select: {
            active: true,
            role: true,
            driver: { select: { id: true } },
          },
        });
        if (!user) throw new NotFoundException('User not found');
        if (!user.active || user.role !== 'DRIVER')
          throw new ConflictException(
            'User must be active with global role DRIVER',
          );
        if (user.driver)
          throw new ConflictException('User already has a driver profile');
        // Every existing Driver counts, whatever its status: there is no deletion in V1.4,
        // so suspending never frees capacity.
        if (
          (await tx.driver.count({ where: { providerId } })) >=
          provider.maxDrivers
        )
          throw new ConflictException('Provider driver limit reached');
        return tx.driver.create({
          data: { providerId, userId: dto.userId, name: dto.name },
          select: driverSelect,
        });
      });
      this.logger.log({
        event: 'DRIVER_CREATED',
        providerId,
        driverId: driver.id,
        userId: driver.userId,
        actorId,
      });
      return withCurrentAssignment(driver);
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException('User already has a driver profile');
      throw error;
    }
  }

  /** requireProvider: admin routes must report a missing provider as 404, not an empty page. */
  async list(
    providerId: string,
    query: DriverListQueryDto,
    requireProvider = false,
  ) {
    if (
      requireProvider &&
      !(await this.prisma.deliveryProvider.findUnique({
        where: { id: providerId },
        select: { id: true },
      }))
    )
      throw new NotFoundException('Provider not found');
    const where: Prisma.DriverWhereInput = {
      providerId,
      status: query.status,
      availability: query.availability,
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              {
                user: {
                  email: { contains: query.search, mode: 'insensitive' },
                },
              },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.driver.findMany({
          where,
          select: driverSelect,
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
        this.prisma.driver.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return pageResult(items.map(withCurrentAssignment), total, query);
  }

  async get(providerId: string, driverId: string) {
    const driver = await this.prisma.driver.findFirst({
      where: { id: driverId, providerId },
      select: driverSelect,
    });
    if (!driver) throw new NotFoundException('Driver not found');
    return withCurrentAssignment(driver);
  }

  async update(
    providerId: string,
    driverId: string,
    dto: UpdateDriverDto,
    actorId: string,
  ) {
    if (!dto || !Object.values(dto).some((value) => value !== undefined))
      throw new BadRequestException('At least one editable field is required');
    const result = await this.prisma.$transaction(async (tx) => {
      const [previous] = await tx.$queryRaw<
        {
          status: DriverStatus;
          availability: DriverAvailability;
          name: string;
        }[]
      >`SELECT status, availability, name FROM "Driver" WHERE id = ${driverId}::uuid AND "providerId" = ${providerId}::uuid FOR UPDATE`;
      if (!previous) throw new NotFoundException('Driver not found');
      const statusChanged =
        dto.status !== undefined && dto.status !== previous.status;
      if (
        statusChanged &&
        !STATUS_TRANSITIONS[previous.status].includes(dto.status!)
      )
        throw new ConflictException('Invalid driver status transition');
      // A driver that is not ACTIVE cannot offer capacity.
      const forceOffline =
        statusChanged &&
        dto.status !== 'ACTIVE' &&
        previous.availability !== 'OFFLINE';
      const driver = await tx.driver.update({
        where: { id: driverId },
        data: {
          name: dto.name,
          status: dto.status,
          ...(forceOffline ? { availability: 'OFFLINE' as const } : {}),
        },
        select: driverSelect,
      });
      return { driver, previous, statusChanged, forceOffline };
    });
    const ids = { providerId, driverId, actorId };
    if (dto.name !== undefined && dto.name !== result.previous.name)
      this.logger.log({ event: 'DRIVER_UPDATED', ...ids });
    if (result.statusChanged)
      this.logger.log({
        event: 'DRIVER_STATUS_CHANGED',
        ...ids,
        from: result.previous.status,
        to: result.driver.status,
      });
    if (result.forceOffline)
      this.logger.log({
        event: 'DRIVER_AVAILABILITY_CHANGED',
        ...ids,
        from: result.previous.availability,
        to: 'OFFLINE',
        reason: 'DRIVER_NOT_ACTIVE',
      });
    return withCurrentAssignment(result.driver);
  }

  /** Resolved exclusively from the authenticated User; no client-supplied driverId. */
  /**
   * The driver's own view of both execution contexts. V1.9 adds `independent`: the capability and
   * whether it can take a service right now. canTakeServices is false while any ACTIVE assignment
   * exists, fleet or independent, because a driver executes one service at a time whichever model
   * it belongs to. currentAssignment stays the V1.4 driver↔vehicle pairing of the provider; it
   * says nothing about independent vehicles, which are listed by GET /driver/vehicles.
   */
  async self(userId: string) {
    const driver = await this.prisma.driver.findUnique({
      where: { userId },
      select: driverSelfSelect,
    });
    if (!driver) throw new NotFoundException('Driver profile not found');
    const { independentProfile, ...rest } = driver;
    const activeAssignment = await this.prisma.deliveryAssignment.findFirst({
      where: { driverId: driver.id, status: 'ACTIVE' },
      select: { id: true, mode: true, dispatchId: true },
    });
    return {
      ...withCurrentAssignment(rest),
      activeDeliveryAssignment: activeAssignment,
      independent: independentProfile
        ? {
            ...independentProfile,
            canTakeServices:
              independentProfile.status === 'APPROVED' && !activeAssignment,
          }
        : null,
    };
  }

  async setOwnAvailability(userId: string, availability: DriverAvailability) {
    const result = await this.prisma.$transaction(async (tx) => {
      const found = await tx.driver.findUnique({
        where: { userId },
        select: { id: true, providerId: true },
      });
      if (!found) throw new NotFoundException('Driver profile not found');
      // Same lock order as suspension (provider → driver).
      const provider = await lockProvider(tx, found.providerId, 'SHARE');
      const [driver] = await tx.$queryRaw<
        { status: DriverStatus; availability: DriverAvailability }[]
      >`SELECT status, availability FROM "Driver" WHERE id = ${found.id}::uuid FOR UPDATE`;
      if (availability !== 'OFFLINE') {
        if (driver.status !== 'ACTIVE')
          throw new ConflictException(
            'Driver must be ACTIVE to offer availability',
          );
        if (provider.status !== 'ACTIVE')
          throw new ConflictException(
            'Provider must be ACTIVE to offer availability',
          );
      }
      if (driver.availability !== availability)
        await tx.driver.update({
          where: { id: found.id },
          data: { availability },
        });
      return { ...found, from: driver.availability };
    });
    if (result.from !== availability)
      this.logger.log({
        event: 'DRIVER_AVAILABILITY_CHANGED',
        providerId: result.providerId,
        driverId: result.id,
        actorId: userId,
        from: result.from,
        to: availability,
      });
    return this.self(userId);
  }
}
