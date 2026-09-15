import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { UsersModule } from '../users/users.module.js';
import { UsersController } from '../users/users.controller.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AccessGuard, RolesGuard } from './auth.guards.js';
@Module({
  imports: [JwtModule.register({}), UsersModule],
  controllers: [AuthController, UsersController],
  providers: [AuthService, AccessGuard, RolesGuard],
  exports: [AccessGuard, RolesGuard, JwtModule, UsersModule],
})
export class AuthModule {}
