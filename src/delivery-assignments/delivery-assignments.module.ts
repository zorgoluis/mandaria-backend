import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { DeliveryAssignmentsService } from './delivery-assignments.service.js';
import { ProviderAssignmentsController } from './provider-assignments.controller.js';
import { AdminAssignmentsController } from './admin-assignments.controller.js';

/** V1.8: which driver and vehicle of the claim owner execute a CLAIMED dispatch. */
@Module({
  imports: [AuthModule, ProvidersModule],
  controllers: [ProviderAssignmentsController, AdminAssignmentsController],
  providers: [DeliveryAssignmentsService],
})
export class DeliveryAssignmentsModule {}
