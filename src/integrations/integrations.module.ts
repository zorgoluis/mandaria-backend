import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsService } from './integrations.service.js';
import { IntegrationGuard } from './integration.guard.js';
@Module({
  imports: [AuthModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsService, IntegrationGuard],
  exports: [IntegrationGuard, IntegrationsService],
})
export class IntegrationsModule {}
