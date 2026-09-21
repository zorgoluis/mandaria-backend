import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { CreditAccountsService } from './credit-accounts.service.js';
import {
  AdminIndependentCreditsController,
  AdminProviderCreditsController,
} from './admin-credits.controller.js';
import {
  DriverCreditsController,
  ProviderCreditsController,
} from './owner-credits.controller.js';

/**
 * V1.10-A: credit accounts and their immutable ledger. Accounting only — claim and take do not
 * consume credits yet, and nothing outside this module moves a balance.
 */
@Module({
  imports: [AuthModule, ProvidersModule],
  controllers: [
    AdminProviderCreditsController,
    AdminIndependentCreditsController,
    ProviderCreditsController,
    DriverCreditsController,
  ],
  providers: [CreditAccountsService],
})
export class CreditsModule {}
