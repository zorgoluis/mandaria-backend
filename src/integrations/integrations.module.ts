import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsService } from './integrations.service.js';
import { IntegrationGuard } from './integration.guard.js';
import { IntegrationAuthService } from './integration-auth.service.js';
import { AdminIntegrationsController } from './admin-integrations.controller.js';
import { IntegrationScopesGuard } from './integration-scopes.js';
@Module({
  imports: [AuthModule],
  controllers: [IntegrationsController, AdminIntegrationsController],
  providers: [
    IntegrationsService,
    IntegrationAuthService,
    IntegrationGuard,
    IntegrationScopesGuard,
  ],
  exports: [IntegrationGuard, IntegrationScopesGuard, IntegrationsService],
})
export class IntegrationsModule {}
