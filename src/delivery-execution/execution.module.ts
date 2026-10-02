import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { ExecutionService } from './execution.service.js';
import {
  AdminExecutionController,
  DriverExecutionController,
  ProviderExecutionController,
} from './execution.controller.js';
@Module({
  imports: [AuthModule, ProvidersModule],
  providers: [ExecutionService],
  controllers: [
    AdminExecutionController,
    DriverExecutionController,
    ProviderExecutionController,
  ],
})
export class ExecutionModule {}
