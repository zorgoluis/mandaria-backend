import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { MailModule } from '../mail/mail.module.js';
import { AdminInvitationsController } from './admin-invitations.controller.js';
import { ProviderInvitationsController } from './provider-invitations.controller.js';
import { AccountActivationController } from './account-activation.controller.js';
import { InvitationsService } from './invitations.service.js';

/** V1.6.1 user provisioning: invitations and account activation. */
@Module({
  imports: [AuthModule, ProvidersModule, MailModule],
  controllers: [
    AdminInvitationsController,
    ProviderInvitationsController,
    AccountActivationController,
  ],
  providers: [InvitationsService],
})
export class InvitationsModule {}
