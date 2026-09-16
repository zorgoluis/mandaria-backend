import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { userAccountStatus } from '../invitations/invitation-policy.js';
import type { UserAccountStatus } from '../invitations/invitation-policy.js';
export const publicUserSelect = {
  id: true,
  email: true,
  role: true,
  active: true,
  emailVerifiedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;
const STATUS_WHERE: Record<UserAccountStatus, Prisma.UserWhereInput> = {
  ACTIVE: { active: true },
  INVITED: { active: false, passwordHash: null },
  DISABLED: { active: false, passwordHash: { not: null } },
};
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}
  findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email } });
  }
  findPublic(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: publicUserSelect,
    });
  }
  /** Last 100 users with their derived account status; password hashes are never loaded. */
  async list(status?: UserAccountStatus) {
    const users = await this.prisma.user.findMany({
      where: status ? STATUS_WHERE[status] : {},
      select: publicUserSelect,
      take: 100,
      orderBy: { createdAt: 'desc' },
    });
    const inactive = users.filter((user) => !user.active).map((u) => u.id);
    const invited = new Set(
      inactive.length
        ? (
            await this.prisma.user.findMany({
              where: { id: { in: inactive }, passwordHash: null },
              select: { id: true },
            })
          ).map((user) => user.id)
        : [],
    );
    return users.map((user) => ({
      ...user,
      status: userAccountStatus({
        active: user.active,
        hasPassword: !invited.has(user.id),
      }),
    }));
  }
}
