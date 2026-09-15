import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { RoutingModule } from '../routing/routing.module.js';
import { ServiceZonesModule } from '../service-zones/service-zones.module.js';
import { RatePlansModule } from '../rate-plans/rate-plans.module.js';
import { DeliveryQuotesController } from './delivery-quotes.controller.js';
import { AdminDeliveryQuotesController } from './admin-delivery-quotes.controller.js';
import { DeliveryQuotesService } from './delivery-quotes.service.js';

/** V1.6: can Mandaria serve this LOCAL_DELIVERY and at what price. No provider/driver assignment. */
@Module({
  imports: [
    AuthModule,
    IntegrationsModule,
    RoutingModule,
    ServiceZonesModule,
    RatePlansModule,
  ],
  controllers: [DeliveryQuotesController, AdminDeliveryQuotesController],
  providers: [DeliveryQuotesService],
})
export class DeliveryQuotesModule {}
