import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { B2bWebhooksModule } from '../b2b-webhooks/b2b-webhooks.module.js';
import { DispatchService } from './dispatch.service.js';
import { ProviderCoveragesService } from './provider-coverages.service.js';
import { ProviderDispatchesController } from './provider-dispatches.controller.js';
import { AdminDispatchesController } from './admin-dispatches.controller.js';

/**
 * V1.7 Dispatch Engine: accepted quotes are offered to eligible providers and exactly one claims
 * each. Opening and cancellation run inside the quote/request transactions (dispatch-policy.ts).
 */
@Module({
  imports: [AuthModule, ProvidersModule, B2bWebhooksModule],
  controllers: [ProviderDispatchesController, AdminDispatchesController],
  providers: [DispatchService, ProviderCoveragesService],
})
export class DispatchModule {}
