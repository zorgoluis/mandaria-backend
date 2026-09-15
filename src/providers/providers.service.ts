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
import { providerSelect } from './provider.select.js';
import { pageResult } from '../common/pagination.dto.js';

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
          select: providerSelect,
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
        this.prisma.deliveryProvider.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return pageResult(items, total, query);
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
      return {
        provider: await tx.deliveryProvider.update({
          where: { id },
          data: { status: target },
          select: providerSelect,
        }),
        changed: true,
      };
    });
    if (result.changed)
      this.logger.log({
        event:
          target === 'ACTIVE' ? 'PROVIDER_ACTIVATED' : 'PROVIDER_SUSPENDED',
        providerId: id,
        actorId,
      });
    return result.provider;
  }
}
