import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit() {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await this.$connect();
        return;
      } catch {
        if (attempt === 9)
          throw new Error('PostgreSQL unavailable after connection retries');
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
