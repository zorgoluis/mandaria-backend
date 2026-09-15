import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOkResponse } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { AccessGuard, Roles, RolesGuard } from '../auth/auth.guards.js';
import { UsersService } from './users.service.js';
@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
@UseGuards(AccessGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
export class UsersController {
  constructor(private readonly users: UsersService) {}
  @Get()
  @ApiOkResponse({ description: 'Últimos 100 usuarios; sólo SUPER_ADMIN' })
  list() {
    return this.users.list();
  }
}
