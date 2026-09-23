import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CreditPoliciesService } from './credit-policies.service.js';
import { AdminCreditPoliciesController } from './admin-credit-policies.controller.js';

/**
 * V1.10-B: versioned credit policies and the pure calculation of a service's credit cost. It only
 * calculates — nothing here debits a CreditAccount; claim/take start consuming credits in V1.10-D.
 * CreditPoliciesService is exported for those later versions.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminCreditPoliciesController],
  providers: [CreditPoliciesService],
  exports: [CreditPoliciesService],
})
export class CreditPoliciesModule {}
