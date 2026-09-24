import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AdminB2bWebhooksController } from './admin-b2b-webhooks.controller.js';
import { B2bWebhooksService } from './b2b-webhooks.service.js';

/**
 * V1.12-C transport. Global, because the delivery paths of both execution models schedule the
 * first attempt after their own transaction has committed, and neither should have to import a
 * transport module to do it.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminB2bWebhooksController],
  providers: [B2bWebhooksService],
  exports: [B2bWebhooksService],
})
export class B2bWebhooksModule {}
