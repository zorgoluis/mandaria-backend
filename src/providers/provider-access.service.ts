import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { DeliveryProvider, ProviderMemberRole } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { PaginationQueryDto, pageResult } from '../common/pagination.dto.js';
import { providerSelect } from './provider.select.js';

export function providerProfile(
  provider: DeliveryProvider,
  membershipRole: ProviderMemberRole,
) {
  return {
    id: provider.id,
    name: provider.name,
    code: provider.code,
    type: provider.type,
    status: provider.status,
    limits: {
      maxDrivers: provider.maxDrivers,
      maxVehicles: provider.maxVehicles,
    },
    membershipRole,
  };
}
@Injectable()
export class ProviderAccessService {
  constructor(private readonly prisma: PrismaService) {}
  async profile(userId: string, providerId?: string) {
    const memberships = await this.prisma.providerMembership.findMany({
      where: { userId, ...(providerId ? { providerId } : {}) },
      take: 2,
      select: { role: true, provider: { select: providerSelect } },
    });
    if (!memberships.length)
      throw new ForbiddenException('Provider access denied');
    if (memberships.length > 1)
      throw new ConflictException(
        'Select providerId; user belongs to multiple providers',
      );
    return providerProfile(memberships[0].provider, memberships[0].role);
  }
  async profiles(userId: string, query: PaginationQueryDto) {
    const where = { userId };
    const [memberships, total] = await this.prisma.$transaction(
      [
        this.prisma.providerMembership.findMany({
          where,
          select: { role: true, provider: { select: providerSelect } },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
        this.prisma.providerMembership.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return pageResult(
      memberships.map((m) => providerProfile(m.provider, m.role)),
      total,
      query,
    );
  }
}
