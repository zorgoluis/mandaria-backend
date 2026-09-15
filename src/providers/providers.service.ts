import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, ProviderStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  CreateProviderDto,
  ProviderListQueryDto,
  UpdateProviderDto,
} from './providers.dto.js';
import { providerSelect, providerUsageSelect } from './provider.select.js';
import { pageResult } from '../common/pagination.dto.js';

function withUsage<
  T extends {
    maxDrivers: number;
    maxVehicles: number;
    _count: { drivers: number; vehicles: number };
  },
>({ _count, ...provider }: T) {
  return {
    ...provider,
    usage: {
      drivers: { count: _count.drivers, max: provider.maxDrivers },
      vehicles: { count: _count.vehicles, max: provider.maxVehicles },
    },
  };
}
@Injectable()
export class ProvidersService {
  private readonly logger = new Logger(ProvidersService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}
  private databaseError(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002')
        throw new ConflictException('Provider code already exists');
      if (error.code === 'P2025')
        throw new NotFoundException('Provider not found');
    }
    throw error;
  }
  async create(dto: CreateProviderDto, actorId: string) {
    try {
      const result = await this.prisma.deliveryProvider.create({
        data: {
          ...dto,
          maxDrivers:
            dto.maxDrivers ??
            this.config.getOrThrow<number>(
              'DEFAULT_' + dto.type + '_MAX_DRIVERS',
            ),
          maxVehicles:
            dto.maxVehicles ??
            this.config.getOrThrow<number>(
              'DEFAULT_' + dto.type + '_MAX_VEHICLES',
            ),
        },
        select: providerSelect,
      });
      this.logger.log({
        event: 'PROVIDER_CREATED',
        providerId: result.id,
        actorId,
      });
      return result;
    } catch (error) {
      return this.databaseError(error);
    }
  }
  async list(query: ProviderListQueryDto) {
    const where: Prisma.DeliveryProviderWhereInput = {
      type: query.type,
      status: query.status,
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { code: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.deliveryProvider.findMany({
          where,
          select: providerUsageSelect,
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
        this.prisma.deliveryProvider.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return pageResult(items.map(withUsage), total, query);
  }
  async capacity(id: string) {
    const provider = await this.prisma.deliveryProvider.findUnique({
      where: { id },
      select: providerUsageSelect,
    });
    if (!provider) throw new NotFoundException('Provider not found');
    const { usage } = withUsage(provider);
    return { providerId: id, ...usage };
  }
  async get(id: string) {
    const provider = await this.prisma.deliveryProvider.findUnique({
      where: { id },
      select: providerSelect,
    });
    if (!provider) throw new NotFoundException('Provider not found');
    return provider;
  }
  async update(id: string, dto: UpdateProviderDto, actorId: string) {
    if (!dto || !Object.values(dto).some((value) => value !== undefined))
      throw new BadRequestException('At least one editable field is required');
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "DeliveryProvider" WHERE id = ${id}::uuid FOR UPDATE`;
        const previous = await tx.deliveryProvider.findUnique({
          where: { id },
          select: providerSelect,
        });
        if (!previous) throw new NotFoundException('Provider not found');
        // The row lock above also serializes with Driver/Vehicle creation.
        if (
          dto.maxDrivers !== undefined &&
          dto.maxDrivers <
            (await tx.driver.count({ where: { providerId: id } }))
        )
          throw new ConflictException(
            'maxDrivers cannot be below current drivers',
          );
        if (
          dto.maxVehicles !== undefined &&
          dto.maxVehicles <
            (await tx.vehicle.count({ where: { providerId: id } }))
        )
          throw new ConflictException(
            'maxVehicles cannot be below current vehicles',
          );
        const current = await tx.deliveryProvider.update({
          where: { id },
          data: dto,
          select: providerSelect,
        });
        return {
          current,
          limitsChanged:
            current.maxDrivers !== previous.maxDrivers ||
            current.maxVehicles !== previous.maxVehicles,
        };
      });
      this.logger.log({ event: 'PROVIDER_UPDATED', providerId: id, actorId });
      if (result.limitsChanged)
        this.logger.log({
          event: 'PROVIDER_LIMITS_CHANGED',
          providerId: id,
          actorId,
          maxDrivers: result.current.maxDrivers,
          maxVehicles: result.current.maxVehicles,
        });
      return result.current;
    } catch (error) {
      return this.databaseError(error);
    }
  }
  async transition(
    id: string,
    target: 'ACTIVE' | 'SUSPENDED',
    actorId: string,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "DeliveryProvider" WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.deliveryProvider.findUnique({
        where: { id },
        select: providerSelect,
      });
      if (!current) throw new NotFoundException('Provider not found');
      if (current.status === target)
        return { provider: current, changed: false };
      const allowed: ProviderStatus[] =
        target === 'ACTIVE' ? ['PENDING', 'SUSPENDED'] : ['ACTIVE'];
      if (!allowed.includes(current.status))
        throw new ConflictException('Invalid provider status transition');
      const provider = await tx.deliveryProvider.update({
        where: { id },
        data: { status: target },
        select: providerSelect,
      });
      // A suspended provider offers no capacity: its drivers cannot stay AVAILABLE/BUSY.
      const offline =
        target === 'SUSPENDED'
          ? (
              await tx.driver.updateMany({
                where: { providerId: id, availability: { not: 'OFFLINE' } },
                data: { availability: 'OFFLINE' },
              })
            ).count
          : 0;
      return { provider, changed: true, offline };
    });
    if (result.changed)
      this.logger.log({
        event:
          target === 'ACTIVE' ? 'PROVIDER_ACTIVATED' : 'PROVIDER_SUSPENDED',
        providerId: id,
        actorId,
      });
    if ('offline' in result && result.offline)
      this.logger.log({
        event: 'DRIVER_AVAILABILITY_CHANGED',
        providerId: id,
        actorId,
        to: 'OFFLINE',
        drivers: result.offline,
        reason: 'PROVIDER_SUSPENDED',
      });
    return result.provider;
  }
}
