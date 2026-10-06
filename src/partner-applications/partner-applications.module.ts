import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MailModule } from '../mail/mail.module.js';
import { AdminPartnerApplicationsController } from './admin-partner-applications.controller.js';
import { PublicPartnerApplicationsController } from './public-partner-applications.controller.js';
import { PartnerApplicationsService } from './partner-applications.service.js';
import { HoneypotInterceptor } from './honeypot.interceptor.js';

/** Partner applications (Fase 1): public capture and SUPER_ADMIN review of landing leads. */
@Module({
  imports: [AuthModule, MailModule],
  controllers: [
    PublicPartnerApplicationsController,
    AdminPartnerApplicationsController,
  ],
  providers: [PartnerApplicationsService, HoneypotInterceptor],
})
export class PartnerApplicationsModule {}
