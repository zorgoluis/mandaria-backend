import { ShippingPolicyController } from './shipping-policy.controller.js';
import { DirectDemandController } from './direct-demand.controller.js';
import { PrequotesModule } from '../delivery-prequotes/prequotes.module.js';
import { DeliveryQuotesModule } from '../delivery-quotes/delivery-quotes.module.js';
import { DeliveryRequestsService } from '../delivery-requests/delivery-requests.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MailModule } from '../mail/mail.module.js';
import { CustomersService } from './customers.service.js';
import {
  CustomerProfileController,
  CustomerRegistrationController,
} from './customers.controller.js';
@Module({
  imports: [AuthModule, MailModule, PrequotesModule, DeliveryQuotesModule],
  providers: [CustomersService, DeliveryRequestsService, IdempotencyService],
  controllers: [
    ShippingPolicyController,
    DirectDemandController,
    CustomerProfileController,
    CustomerRegistrationController,
  ],
  exports: [CustomersService],
})
export class CustomersModule {}
