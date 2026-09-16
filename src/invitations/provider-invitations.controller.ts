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
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AccessGuard, Roles, RolesGuard } from '../auth/auth.guards.js';
import type { AuthenticatedRequest } from '../auth/auth.guards.js';
import {
  CurrentProvider,
  ProviderMembershipGuard,
} from '../providers/provider-membership.guard.js';
import type { ProviderProfile } from '../providers/provider-membership.guard.js';
import { ProviderProfileQueryDto } from '../providers/providers.dto.js';
import { PROVIDER_SCOPE_DOC } from '../drivers/provider-drivers.controller.js';
import { InvitationsService } from './invitations.service.js';
import type { InvitationScope } from './invitations.service.js';
import {
  CreateDriverInvitationDto,
  ProviderInvitationListQueryDto,
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

/** The provider comes from the membership guard, never from an unchecked client value. */
const scopeOf = (provider: ProviderProfile): InvitationScope => ({
  providerId: provider.id,
  role: 'DRIVER',
});

@ApiTags('Provider Driver Invitations')
@ApiBearerAuth()
@UseGuards(AccessGuard, RolesGuard, ProviderMembershipGuard)
@Roles('PROVIDER_ADMIN')
@Controller('provider/driver-invitations')
export class ProviderInvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiCreatedResponse({ type: UserInvitationDispatchResponse })
  @ApiInviteErrors(20)
  @ApiOperation({
    summary: 'Invitar repartidor a mi proveedor',
    description:
      'Crea un User INVITED con rol DRIVER y una invitación PENDING para el proveedor autorizado por membership; el Driver se crea al activar. El payload no acepta role ni providerId: un PROVIDER_ADMIN sólo puede invitar DRIVER y nunca PROVIDER_ADMIN/SUPER_ADMIN. Reserva un lugar de maxDrivers mientras esté pendiente y vigente. 20/min por IP.' +
      PROVIDER_SCOPE_DOC,
  })
  invite(
    @Query() _scope: ProviderProfileQueryDto,
    @CurrentProvider() provider: ProviderProfile,
    @Body() dto: CreateDriverInvitationDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.invitations.invite(
      provider.id,
      { email: dto.email, role: 'DRIVER', driverName: dto.driverName },
      req.user,
    );
  }

  @Get()
  @ApiOkResponse({ type: UserInvitationPageResponse })
  @ApiReadErrors
  @ApiOperation({
    summary: 'Listar invitaciones de repartidores de mi proveedor',
    description:
      'Sólo invitaciones DRIVER del proveedor autorizado; nunca de otros proveedores ni invitaciones PROVIDER_ADMIN. Filtros status efectivo y search por email; paginación.' +
      PROVIDER_SCOPE_DOC,
  })
  list(
    @Query() query: ProviderInvitationListQueryDto,
    @CurrentProvider() provider: ProviderProfile,
  ) {
    return this.invitations.list(query, scopeOf(provider));
  }

  @Get(':invitationId')
  @invitationParam
  @ApiOkResponse({ type: UserInvitationResponse })
  @ApiReadErrors
  @ApiOperation({
    summary: 'Consultar invitación de repartidor',
    description:
      'Invitación DRIVER del proveedor autorizado.' + PROVIDER_SCOPE_DOC,
  })
  get(
    @Query() _scope: ProviderProfileQueryDto,
    @CurrentProvider() provider: ProviderProfile,
    @Param('invitationId', new ParseUUIDPipe()) id: string,
  ) {
    return this.invitations.get(id, scopeOf(provider));
  }

  @Post(':invitationId/resend')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @invitationParam
  @ApiOkResponse({ type: UserInvitationDispatchResponse })
  @ApiResendErrors
  @ApiOperation({
    summary: 'Reenviar invitación de repartidor',
    description:
      'Invitación DRIVER del proveedor autorizado.' +
      RESEND_DOC +
      PROVIDER_SCOPE_DOC,
  })
  resend(
    @Query() _scope: ProviderProfileQueryDto,
    @CurrentProvider() provider: ProviderProfile,
    @Param('invitationId', new ParseUUIDPipe()) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.invitations.resend(id, scopeOf(provider), req.user.id);
  }

  @Post(':invitationId/revoke')
  @HttpCode(200)
  @invitationParam
  @ApiOkResponse({ type: UserInvitationResponse })
  @ApiRevokeErrors
  @ApiOperation({
    summary: 'Revocar invitación de repartidor',
    description:
      'Invitación DRIVER del proveedor autorizado.' +
      REVOKE_DOC +
      PROVIDER_SCOPE_DOC,
  })
  revoke(
    @Query() _scope: ProviderProfileQueryDto,
    @CurrentProvider() provider: ProviderProfile,
    @Param('invitationId', new ParseUUIDPipe()) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.invitations.revoke(id, scopeOf(provider), req.user.id);
  }
}
