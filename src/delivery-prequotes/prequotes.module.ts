import { PrequoteConversionController } from './prequote-conversion.controller.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { PrequoteConversionService } from './prequote-conversion.service.js';
import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { RoutingModule } from '../routing/routing.module.js';
import { ServiceZonesModule } from '../service-zones/service-zones.module.js';
import { RatePlansModule } from '../rate-plans/rate-plans.module.js';
import { PrequotesController } from './prequotes.controller.js';
import { PrequotesService } from './prequotes.service.js';
import { PrequotePersistenceService } from './prequote-persistence.service.js';
import { PREQUOTE_CONSUMPTION } from './prequote-consumption.js';
import { DurablePrequoteConsumption } from './durable-prequote-consumption.js';
@Module({
  exports: [PrequotesService, PrequoteConversionService],
  imports: [
    IntegrationsModule,
    RoutingModule,
    ServiceZonesModule,
    RatePlansModule,
  ],
  controllers: [PrequotesController, PrequoteConversionController],
  providers: [
    IdempotencyService,
    PrequoteConversionService,
    PrequotesService,
    PrequotePersistenceService,
    { provide: PREQUOTE_CONSUMPTION, useClass: DurablePrequoteConsumption },
  ],
})
export class PrequotesModule {}
