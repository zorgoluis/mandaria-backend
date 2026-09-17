import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  ProviderServiceCoverageStatus,
  ServiceType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { isUniqueViolation } from '../providers/provider-capacity.js';
import { dispatchError } from './dispatch-policy.js';

export const coverageSelect = {
  id: true,
  providerId: true,
  serviceType: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  serviceZone: { select: { id: true, code: true, name: true, status: true } },
} as const;

/** Where and which services each provider may take (V1.7 dispatch eligibility). */
@Injectable()
export class ProviderCoveragesService {
  private readonly logger = new Logger(ProviderCoveragesService.name);
  constructor(private readonly prisma: PrismaService) {}

  async create(
    providerId: string,
    input: { serviceZoneId: string; serviceType: ServiceType },
    actorId: string,
  ) {
    const [provider, zone] = await Promise.all([
      this.prisma.deliveryProvider.findUnique({
        where: { id: providerId },
        select: { id: true },
      }),
      this.prisma.serviceZone.findUnique({
        where: { id: input.serviceZoneId },
        select: { id: true },
      }),
    ]);
    if (!provider) throw new NotFoundException('Provider not found');
    if (!zone) throw new NotFoundException('Service zone not found');
    try {
      const coverage = await this.prisma.providerServiceCoverage.create({
        data: { providerId, ...input },
        select: coverageSelect,
      });
      this.logger.log({
        event: 'PROVIDER_COVERAGE_CREATED',
        coverageId: coverage.id,
        providerId,
        serviceZoneId: input.serviceZoneId,
        serviceType: input.serviceType,
        actorId,
      });
      return coverage;
    } catch (error) {
      if (isUniqueViolation(error))
        throw dispatchError(
          'SERVICE_COVERAGE_EXISTS',
          'Provider already has coverage for this zone and service type',
        );
      throw error;
    }
  }

  async list(providerId: string, requireProvider = false) {
    if (
      requireProvider &&
      !(await this.prisma.deliveryProvider.findUnique({
        where: { id: providerId },
        select: { id: true },
      }))
    )
      throw new NotFoundException('Provider not found');
    return this.prisma.providerServiceCoverage.findMany({
      where: { providerId },
      select: coverageSelect,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  async setStatus(
    providerId: string,
    coverageId: string,
    status: ProviderServiceCoverageStatus,
    actorId: string,
  ) {
    const updated = await this.prisma.providerServiceCoverage.updateMany({
      where: { id: coverageId, providerId },
      data: { status },
    });
    if (!updated.count) throw new NotFoundException('Coverage not found');
    this.logger.log({
      event: 'PROVIDER_COVERAGE_UPDATED',
      coverageId,
      providerId,
      status,
      actorId,
    });
    return this.prisma.providerServiceCoverage.findUniqueOrThrow({
      where: { id: coverageId },
      select: coverageSelect,
    });
  }
}
