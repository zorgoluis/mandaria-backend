import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AccessGuard, Roles, RolesGuard } from '../auth/auth.guards.js';
import type { AuthenticatedRequest } from '../auth/auth.guards.js';
import { ApiErrors } from '../common/api-errors.decorator.js';
import { PaginationQueryDto } from '../common/pagination.dto.js';
import { ProviderAccessService } from './provider-access.service.js';
import {
  CurrentProvider,
  ProviderMembershipGuard,
} from './provider-membership.guard.js';
import type { ProviderProfile } from './provider-membership.guard.js';
import { ProviderProfileQueryDto } from './providers.dto.js';
import {
  ProviderProfilePageResponse,
  ProviderProfileResponse,
} from './providers.responses.js';

@ApiTags('Provider')
@ApiBearerAuth()
@ApiErrors(400, 401, 403, 429, 500)
@UseGuards(AccessGuard, RolesGuard)
@Roles('PROVIDER_ADMIN')
@Controller('provider')
export class ProviderController {
  constructor(private readonly access: ProviderAccessService) {}
  @Get('profile')
  @UseGuards(ProviderMembershipGuard)
  @ApiErrors(409)
  @ApiOkResponse({ type: ProviderProfileResponse })
  @ApiOperation({
    summary: 'Consultar perfil de un proveedor asociado',
    description:
      'Requiere JWT humano, User activo con rol PROVIDER_ADMIN y membership actual. providerId puede omitirse con exactamente una membership; sin memberships devuelve 403, con varias y sin seleccionar devuelve 409. Un ID ajeno o inexistente devuelve el mismo 403. PENDING/SUSPENDED siguen siendo consultables; esto no concede operaciones logísticas. OWNER y ADMIN tienen igual acceso de lectura en V1.2.',
  })
  profile(
    @Query() _query: ProviderProfileQueryDto,
    @CurrentProvider() profile: ProviderProfile,
  ) {
    return profile;
  }
  @Get('profiles')
  @ApiOkResponse({ type: ProviderProfilePageResponse })
  @ApiOperation({
    summary: 'Identificar mis proveedores asociados',
    description:
      'Sólo PROVIDER_ADMIN activo. Lista paginada filtrada por el User autenticado, nunca por un userId recibido del cliente. Permite seleccionar providerId para /provider/profile cuando hay varias memberships. Sin asociaciones devuelve items vacío. No muestra miembros de otros proveedores.',
  })
  profiles(
    @Query() query: PaginationQueryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.access.profiles(req.user.id, query);
  }
}
