import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AdminProvidersController } from './admin-providers.controller.js';
import { ProviderController } from './provider.controller.js';
import { ProvidersService } from './providers.service.js';
import { ProviderMembersService } from './provider-members.service.js';
import { ProviderAccessService } from './provider-access.service.js';
import { ProviderMembershipGuard } from './provider-membership.guard.js';
@Module({
  imports: [AuthModule],
  controllers: [AdminProvidersController, ProviderController],
  providers: [
    ProvidersService,
    ProviderMembersService,
    ProviderAccessService,
    ProviderMembershipGuard,
  ],
  exports: [ProvidersService, ProviderAccessService, ProviderMembershipGuard],
})
export class ProvidersModule {}
