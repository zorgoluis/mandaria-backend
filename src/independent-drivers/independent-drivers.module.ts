import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { IndependentDriversService } from './independent-drivers.service.js';
import { IndependentDispatchesService } from './independent-dispatches.service.js';
import { AdminIndependentDriversController } from './admin-independent-drivers.controller.js';
import { DriverDispatchesController } from './driver-dispatches.controller.js';

/**
 * V1.9: the second execution model. An existing Driver enabled by SUPER_ADMIN takes dispatches for
 * itself, with its own vehicles, and its take/release converge on the same DeliveryAssignment the
 * fleet model uses. No DeliveryProvider is involved at any point.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminIndependentDriversController, DriverDispatchesController],
  providers: [IndependentDriversService, IndependentDispatchesService],
  exports: [IndependentDispatchesService],
})
export class IndependentDriversModule {}
