import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AdminRatePlansController } from './admin-rate-plans.controller.js';
import { RatePlansService } from './rate-plans.service.js';

@Module({
  imports: [AuthModule],
  controllers: [AdminRatePlansController],
  providers: [RatePlansService],
  exports: [RatePlansService],
})
export class RatePlansModule {}
