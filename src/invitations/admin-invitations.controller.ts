import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AccessGuard, Roles, RolesGuard } from '../auth/auth.guards.js';
import type { AuthenticatedRequest } from '../auth/auth.guards.js';
import { InvitationsService } from './invitations.service.js';
import {
  AdminInvitationListQueryDto,
  CreateUserInvitationDto,
} from './invitations.dto.js';
import {
  UserInvitationDispatchResponse,
  UserInvitationPageResponse,
  UserInvitationResponse,
} from './invitations.responses.js';
import {
  ApiInviteErrors,
  ApiReadErrors,
  ApiResendErrors,
  ApiRevokeErrors,
  RESEND_DOC,
  REVOKE_DOC,
  invitationParam,
} from './invitation-docs.js';

@ApiTags('Admin User Invitations')
@ApiBearerAuth()
@UseGuards(AccessGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller()
export class AdminInvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post('admin/providers/:providerId/invitations')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiParam({ name: 'providerId', format: 'uuid' })
  @ApiCreatedResponse({ type: UserInvitationDispatchResponse })
  @ApiInviteErrors(20)
  @ApiOperation({
    summary: 'Invitar PROVIDER_ADMIN o DRIVER a un proveedor',
    description:
      'Sólo SUPER_ADMIN. Crea (o reutiliza, si nunca se activó y no tiene invitación pendiente) un User INVITED sin contraseña y una invitación PENDING con token de un solo uso cuyo hash SHA-256 es lo único almacenado; envía el correo con {MANDARIA_WEB_URL}/activate-account?token=… El administrador nunca define ni conoce la contraseña. PROVIDER_ADMIN requiere membershipRole (OWNER/ADMIN); DRIVER requiere driverName y reserva un lugar de maxDrivers. La membership o el Driver se crean al activar la cuenta. SUPER_ADMIN no es invitable. Invitaciones simultáneas al mismo email producen un solo User y una sola invitación. 20/min por IP.',
  })
  invite(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Body() dto: CreateUserInvitationDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.invitations.invite(providerId, dto, req.user);
  }

  @Get('admin/user-invitations')
  @ApiOkResponse({ type: UserInvitationPageResponse })
  @ApiReadErrors
  @ApiOperation({
    summary: 'Listar invitaciones',
    description:
      'Sólo SUPER_ADMIN. Filtros status efectivo (PENDING/EXPIRED/ACCEPTED/REVOKED), role, providerId y search por email; paginación. Nunca incluye token ni hash.',
  })
  list(@Query() query: AdminInvitationListQueryDto) {
    return this.invitations.list(query, null);
  }

  @Get('admin/user-invitations/:invitationId')
  @invitationParam
  @ApiOkResponse({ type: UserInvitationResponse })
  @ApiReadErrors
  @ApiOperation({
    summary: 'Consultar invitación',
    description: 'Sólo SUPER_ADMIN. Nunca incluye token ni hash.',
  })
  get(@Param('invitationId', new ParseUUIDPipe()) id: string) {
    return this.invitations.get(id, null);
  }

  @Post('admin/user-invitations/:invitationId/resend')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @invitationParam
  @ApiOkResponse({ type: UserInvitationDispatchResponse })
  @ApiResendErrors
  @ApiOperation({
    summary: 'Reenviar invitación',
    description: 'Sólo SUPER_ADMIN.' + RESEND_DOC,
  })
  resend(
    @Param('invitationId', new ParseUUIDPipe()) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.invitations.resend(id, null, req.user.id);
  }

  @Post('admin/user-invitations/:invitationId/revoke')
  @HttpCode(200)
  @invitationParam
  @ApiOkResponse({ type: UserInvitationResponse })
  @ApiRevokeErrors
  @ApiOperation({
    summary: 'Revocar invitación pendiente',
    description: 'Sólo SUPER_ADMIN.' + REVOKE_DOC,
  })
  revoke(
    @Param('invitationId', new ParseUUIDPipe()) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.invitations.revoke(id, null, req.user.id);
  }
}
