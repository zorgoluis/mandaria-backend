import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { RoutingModule } from '../routing/routing.module.js';
import { ServiceZonesModule } from '../service-zones/service-zones.module.js';
import { RatePlansModule } from '../rate-plans/rate-plans.module.js';
import { PrequotesController } from './prequotes.controller.js';
import { PrequotesService } from './prequotes.service.js';
import { PrequotePersistenceService } from './prequote-persistence.service.js';
import {
  PREQUOTE_CONSUMPTION,
  UnavailablePrequoteConsumption,
} from './prequote-consumption.js';
@Module({
  imports: [
    IntegrationsModule,
    RoutingModule,
    ServiceZonesModule,
    RatePlansModule,
  ],
  controllers: [PrequotesController],
  providers: [
    PrequotesService,
    PrequotePersistenceService,
    { provide: PREQUOTE_CONSUMPTION, useClass: UnavailablePrequoteConsumption },
  ],
})
export class PrequotesModule {}
