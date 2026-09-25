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
import { ServiceZonesModule } from './service-zones/service-zones.module.js';
import { RatePlansModule } from './rate-plans/rate-plans.module.js';
import { DeliveryQuotesModule } from './delivery-quotes/delivery-quotes.module.js';
import { InvitationsModule } from './invitations/invitations.module.js';
import { DispatchModule } from './dispatch/dispatch.module.js';
import { DeliveryAssignmentsModule } from './delivery-assignments/delivery-assignments.module.js';
import { IndependentDriversModule } from './independent-drivers/independent-drivers.module.js';
import { CreditsModule } from './credits/credits.module.js';
import { CreditPoliciesModule } from './credit-policies/credit-policies.module.js';
import { B2bWebhooksModule } from './b2b-webhooks/b2b-webhooks.module.js';
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
    ServiceZonesModule,
    RatePlansModule,
    DeliveryQuotesModule,
    InvitationsModule,
    DispatchModule,
    DeliveryAssignmentsModule,
    IndependentDriversModule,
    CreditsModule,
    CreditPoliciesModule,
    B2bWebhooksModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
