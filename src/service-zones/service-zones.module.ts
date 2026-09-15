import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AdminServiceZonesController } from './admin-service-zones.controller.js';
import { ServiceZonesService } from './service-zones.service.js';

@Module({
  imports: [AuthModule],
  controllers: [AdminServiceZonesController],
  providers: [ServiceZonesService],
  exports: [ServiceZonesService],
})
export class ServiceZonesModule {}
