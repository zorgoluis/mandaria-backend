import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiPropertyOptional,
  ApiTags,
  ApiOkResponse,
} from '@nestjs/swagger';
import { IsIn, ValidateIf } from 'class-validator';
import { Role } from '@prisma/client';
import { AccessGuard, Roles, RolesGuard } from '../auth/auth.guards.js';
import { USER_ACCOUNT_STATUSES } from '../invitations/invitation-policy.js';
import type { UserAccountStatus } from '../invitations/invitation-policy.js';
import { UserResponse } from '../invitations/invitations.responses.js';
import { UsersService } from './users.service.js';
export class UserListQueryDto {
  @ApiPropertyOptional({ enum: USER_ACCOUNT_STATUSES })
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(USER_ACCOUNT_STATUSES)
  status?: UserAccountStatus;
}
@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
@UseGuards(AccessGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
export class UsersController {
  constructor(private readonly users: UsersService) {}
  @Get()
  @ApiOkResponse({ type: UserResponse, isArray: true })
  @ApiOperation({
    summary: 'Listar usuarios',
    description:
      'Últimos 100 usuarios; sólo SUPER_ADMIN. status derivado: INVITED (nunca activada, sin contraseña), ACTIVE, DISABLED. Filtro opcional status. Nunca incluye passwordHash ni tokens. Las cuentas se aprovisionan por invitación; no existe alta con contraseña definida por un administrador.',
  })
  list(@Query() query: UserListQueryDto) {
    return this.users.list(query.status);
  }
}
