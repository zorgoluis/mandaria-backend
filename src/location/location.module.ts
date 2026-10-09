import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { LocationService, LocationClock } from './location.service.js';
import {
  DriverLocationController,
  CustomerLocationController,
  B2bLocationController,
  SharedLocationController,
} from './location.controller.js';
@Module({
  imports: [AuthModule, IntegrationsModule, CustomersModule],
  providers: [LocationService, LocationClock],
  controllers: [
    DriverLocationController,
    CustomerLocationController,
    B2bLocationController,
    SharedLocationController,
  ],
})
export class LocationModule {}
