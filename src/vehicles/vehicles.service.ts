import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { VehicleStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { pageResult } from '../common/pagination.dto.js';
import {
  isUniqueViolation,
  lockProvider,
} from '../providers/provider-capacity.js';
import { withCurrentAssignment } from '../assignments/assignment.select.js';
import {
  CreateVehicleDto,
  UpdateVehicleDto,
  VehicleListQueryDto,
} from './vehicles.dto.js';
import { vehicleSelect } from './vehicle.select.js';

const duplicate = () =>
  new ConflictException('Vehicle identifier already exists in this provider');

@Injectable()
export class VehiclesService {
  private readonly logger = new Logger(VehiclesService.name);
  constructor(private readonly prisma: PrismaService) {}

  /** providerId must already be authorized (SUPER_ADMIN path or membership guard). */
  async create(providerId: string, dto: CreateVehicleDto, actorId: string) {
    try {
      const vehicle = await this.prisma.$transaction(async (tx) => {
        const provider = await lockProvider(tx, providerId);
        // All existing vehicles count, whatever their status (no deletion in V1.4).
        if (
          (await tx.vehicle.count({ where: { providerId } })) >=
          provider.maxVehicles
        )
          throw new ConflictException('Provider vehicle limit reached');
        return tx.vehicle.create({
          data: { ...dto, providerId },
          select: vehicleSelect,
        });
      });
      this.logger.log({
        event: 'VEHICLE_CREATED',
        providerId,
        vehicleId: vehicle.id,
        actorId,
      });
      return withCurrentAssignment(vehicle);
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicate();
      throw error;
    }
  }

  /** requireProvider: admin routes must report a missing provider as 404, not an empty page. */
  async list(
    providerId: string,
    query: VehicleListQueryDto,
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
    const contains = { contains: query.search, mode: 'insensitive' } as const;
    const where: Prisma.VehicleWhereInput = {
      providerId,
      type: query.type,
      status: query.status,
      ...(query.search
        ? {
            OR: [
              { identifier: contains },
              { plate: contains },
              { brand: contains },
              { model: contains },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.vehicle.findMany({
          where,
          select: vehicleSelect,
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
        this.prisma.vehicle.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return pageResult(items.map(withCurrentAssignment), total, query);
  }

  async get(providerId: string, vehicleId: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, providerId },
      select: vehicleSelect,
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    return withCurrentAssignment(vehicle);
  }

  async update(
    providerId: string,
    vehicleId: string,
    dto: UpdateVehicleDto,
    actorId: string,
  ) {
    if (!dto || !Object.values(dto).some((value) => value !== undefined))
      throw new BadRequestException('At least one editable field is required');
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const [previous] = await tx.$queryRaw<
          { status: VehicleStatus }[]
        >`SELECT status FROM "Vehicle" WHERE id = ${vehicleId}::uuid AND "providerId" = ${providerId}::uuid FOR UPDATE`;
        if (!previous) throw new NotFoundException('Vehicle not found');
        const vehicle = await tx.vehicle.update({
          where: { id: vehicleId },
          data: dto,
          select: vehicleSelect,
        });
        return { vehicle, from: previous.status };
      });
      const ids = { providerId, vehicleId, actorId };
      const { status, ...details } = dto;
      if (Object.values(details).some((value) => value !== undefined))
        this.logger.log({ event: 'VEHICLE_UPDATED', ...ids });
      if (status !== undefined && status !== result.from)
        this.logger.log({
          event: 'VEHICLE_STATUS_CHANGED',
          ...ids,
          from: result.from,
          to: status,
        });
      return withCurrentAssignment(result.vehicle);
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicate();
      throw error;
    }
  }
}
