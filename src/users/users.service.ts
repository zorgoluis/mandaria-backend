import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
export const publicUserSelect = {
  id: true,
  email: true,
  role: true,
  active: true,
  emailVerifiedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;
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
  list() {
    return this.prisma.user.findMany({
      select: publicUserSelect,
      take: 100,
      orderBy: { createdAt: 'desc' },
    });
  }
}
