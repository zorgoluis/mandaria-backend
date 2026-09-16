import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { PaginationQueryDto, pageResult } from '../common/pagination.dto.js';
import { AddProviderMemberDto } from './providers.dto.js';
import { memberSelect } from './provider.select.js';

@Injectable()
export class ProviderMembersService {
  private readonly logger = new Logger(ProviderMembersService.name);
  constructor(private readonly prisma: PrismaService) {}
  async add(providerId: string, dto: AddProviderMemberDto, actorId: string) {
    try {
      const member = await this.prisma.$transaction(async (tx) => {
        if (
          !(await tx.deliveryProvider.findUnique({
            where: { id: providerId },
            select: { id: true },
          }))
        )
          throw new NotFoundException('Provider not found');
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${dto.userId}::uuid FOR UPDATE`;
        const user = await tx.user.findUnique({
          where: { id: dto.userId },
          select: { active: true, role: true },
        });
        if (!user) throw new NotFoundException('User not found');
        if (!user.active || user.role !== 'PROVIDER_ADMIN')
          throw new ConflictException(
            'User must be active with global role PROVIDER_ADMIN',
          );
        return tx.providerMembership.create({
          data: { providerId, userId: dto.userId, role: dto.role },
          select: memberSelect,
        });
      });
      this.logger.log({
        event: 'PROVIDER_MEMBER_ADDED',
        providerId,
        membershipId: member.id,
        userId: member.userId,
        actorId,
      });
      return member;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new ConflictException(
          'User is already a member of this provider',
        );
      throw error;
    }
  }
  async list(providerId: string, query: PaginationQueryDto) {
    if (
      !(await this.prisma.deliveryProvider.findUnique({
        where: { id: providerId },
        select: { id: true },
      }))
    )
      throw new NotFoundException('Provider not found');
    const where = { providerId };
    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.providerMembership.findMany({
          where,
          select: memberSelect,
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
        this.prisma.providerMembership.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return pageResult(items, total, query);
  }
  async remove(providerId: string, membershipId: string, actorId: string) {
    const removed = await this.prisma.providerMembership.deleteMany({
      where: { id: membershipId, providerId },
    });
    if (!removed.count)
      throw new NotFoundException('Provider membership not found');
    this.logger.log({
      event: 'PROVIDER_MEMBER_REMOVED',
      providerId,
      membershipId,
      actorId,
    });
  }
}
