import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service.js';
@ApiTags('Health')
@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}
  @Get()
  @ApiOkResponse({ description: 'Backend y PostgreSQL disponibles' })
  @ApiServiceUnavailableResponse({ description: 'PostgreSQL no disponible' })
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException();
    }
    return { status: 'ok', database: 'up' };
  }
}
