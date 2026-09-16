import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { AssignmentsService } from '../assignments/assignments.service.js';
import { AdminVehiclesController } from '../vehicles/admin-vehicles.controller.js';
import { ProviderVehiclesController } from '../vehicles/provider-vehicles.controller.js';
import { VehiclesService } from '../vehicles/vehicles.service.js';
import { AdminDriversController } from './admin-drivers.controller.js';
import { ProviderDriversController } from './provider-drivers.controller.js';
import { DriverSelfController } from './driver-self.controller.js';
import { DriversService } from './drivers.service.js';

/** V1.4 logistic capacity of a provider: Drivers, Vehicles and their assignments. */
@Module({
  imports: [AuthModule, ProvidersModule],
  controllers: [
    AdminDriversController,
    ProviderDriversController,
    DriverSelfController,
    AdminVehiclesController,
    ProviderVehiclesController,
  ],
  providers: [DriversService, VehiclesService, AssignmentsService],
})
export class DriversModule {}
