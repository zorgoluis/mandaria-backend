import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { DeliveryRequestsController } from './delivery-requests.controller.js';
import { AdminDeliveryRequestsController } from './admin-delivery-requests.controller.js';
import { DeliveryRequestsService } from './delivery-requests.service.js';

/** V1.5 demand side: what must be transported. No provider, driver or pricing relation. */
@Module({
  imports: [AuthModule, IntegrationsModule],
  controllers: [DeliveryRequestsController, AdminDeliveryRequestsController],
  providers: [DeliveryRequestsService, IdempotencyService],
})
export class DeliveryRequestsModule {}
