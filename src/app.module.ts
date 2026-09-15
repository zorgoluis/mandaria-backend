import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validateEnvironment } from './config/environment.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { IntegrationsModule } from './integrations/integrations.module.js';
import { HealthModule } from './health/health.module.js';
import { ProvidersModule } from './providers/providers.module.js';
import { DriversModule } from './drivers/drivers.module.js';
import { DeliveryRequestsModule } from './delivery-requests/delivery-requests.module.js';
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
    PrismaModule,
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    AuthModule,
    IntegrationsModule,
    HealthModule,
    ProvidersModule,
    DriversModule,
    DeliveryRequestsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
