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
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AccessGuard, Roles, RolesGuard } from '../auth/auth.guards.js';
import type { AuthenticatedRequest } from '../auth/auth.guards.js';
import { ApiErrorDescriptions } from '../common/api-errors.decorator.js';
import {
  CurrentProvider,
  ProviderMembershipGuard,
} from '../providers/provider-membership.guard.js';
import type { ProviderProfile } from '../providers/provider-membership.guard.js';
import { PROVIDER_SCOPE_DOC } from '../drivers/provider-drivers.controller.js';
import { DispatchService } from './dispatch.service.js';
import { ProviderCoveragesService } from './provider-coverages.service.js';
import {
  ClaimDispatchDto,
  ProviderDispatchListQueryDto,
  ProviderDispatchScopeDto,
  ReleaseDispatchDto,
} from './dispatch.dto.js';
import {
  ProviderDispatchPageResponse,
  ProviderDispatchResponse,
  ServiceCoverageResponse,
} from './dispatch.responses.js';

const dispatchParam = ApiParam({
  name: 'dispatchId',
  format: 'uuid',
  description:
    'Dispatch.id. Si mi proveedor no fue candidato responde 404 igual que un id inexistente.',
});
const errors = {
  400: 'VALIDATION_ERROR: UUID, filtros o motivo inválidos; campos desconocidos rechazados.',
  401: 'Se requiere access JWT humano de un User ACTIVE; un token B2B (IntegrationClient) no es válido.',
  403: 'Rol global distinto de PROVIDER_ADMIN (SUPER_ADMIN y DRIVER incluidos) o sin membership en el providerId indicado.',
  404: 'Dispatch inexistente o en el que mi proveedor no fue candidato.',
  429: 'Límite de peticiones por IP.',
  500: 'Error interno sanitizado.',
};

@ApiTags('Provider Dispatches')
@ApiBearerAuth()
@UseGuards(AccessGuard, RolesGuard, ProviderMembershipGuard)
@Roles('PROVIDER_ADMIN')
@Controller('provider')
export class ProviderDispatchesController {
  constructor(
    private readonly dispatches: DispatchService,
    private readonly coverages: ProviderCoveragesService,
  ) {}

  @Get('dispatches')
  @ApiOkResponse({ type: ProviderDispatchPageResponse })
  @ApiErrorDescriptions(errors)
  @ApiOperation({
    summary: 'Listar Dispatches de mi proveedor',
    description:
      'Sólo Dispatches en los que mi proveedor fue candidato (snapshot tomado al abrirse; no se recalcula). view=AVAILABLE devuelve los reclamables (OPEN, vigentes, candidatura OFFERED) ordenados por expiresAt; view=CLAIMED los que tengo tomados; status filtra por estado efectivo. El detalle expuesto depende de access (OWNER/OFFER/SUMMARY).' +
      PROVIDER_SCOPE_DOC,
  })
  list(
    @Query() query: ProviderDispatchListQueryDto,
    @CurrentProvider() provider: ProviderProfile,
  ) {
    return this.dispatches.listForProvider(provider.id, query);
  }

  @Get('dispatches/:dispatchId')
  @dispatchParam
  @ApiOkResponse({ type: ProviderDispatchResponse })
  @ApiErrorDescriptions(errors)
  @ApiOperation({
    summary: 'Consultar Dispatch de mi proveedor',
    description:
      'Aislado por candidatura: un Dispatch ajeno responde 404.' +
      PROVIDER_SCOPE_DOC,
  })
  get(
    @Query() _scope: ProviderDispatchScopeDto,
    @CurrentProvider() provider: ProviderProfile,
    @Param('dispatchId', new ParseUUIDPipe()) dispatchId: string,
  ) {
    return this.dispatches.getForProvider(dispatchId, provider.id);
  }

  @Post('dispatches/:dispatchId/claim')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @dispatchParam
  @ApiOkResponse({ type: ProviderDispatchResponse })
  @ApiErrorDescriptions({
    ...errors,
    409: 'DISPATCH_ALREADY_CLAIMED (otro proveedor ganó; también el perdedor de una carrera concurrente) | DISPATCH_EXPIRED (now >= expiresAt; se persiste EXPIRED) | DISPATCH_CANCELLED | DISPATCH_RECLAIM_NOT_ALLOWED (mi proveedor ya lo liberó) | PROVIDER_NOT_ELIGIBLE (proveedor ya no ACTIVE o cobertura de zona/servicio INACTIVE).',
    429: 'Límite de 60 peticiones/minuto por IP.',
  })
  @ApiOperation({
    summary: 'Reclamar Dispatch para mi proveedor',
    description:
      'Sin body (cualquier campo, incluido providerId, se rechaza con 400): el proveedor sale de la membership (providerId en query sólo selecciona entre mis memberships) y debe ser candidato OFFERED de un Dispatch OPEN y vigente, además de seguir elegible. Bloqueo de fila del Dispatch: con claims simultáneos gana exactamente uno y el resto recibe 409 sin cambios. Repetir el claim del propio ganador devuelve 200 sin cambios. No asigna Driver ni Vehicle. SUPER_ADMIN, DRIVER e IntegrationClient no pueden reclamar. 60/min por IP.' +
      PROVIDER_SCOPE_DOC,
  })
  claim(
    @Query() _scope: ProviderDispatchScopeDto,
    @CurrentProvider() provider: ProviderProfile,
    @Param('dispatchId', new ParseUUIDPipe()) dispatchId: string,
    @Body() _body: ClaimDispatchDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.dispatches.claim(dispatchId, provider.id, req.user.id);
  }

  @Post('dispatches/:dispatchId/release')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @dispatchParam
  @ApiOkResponse({ type: ProviderDispatchResponse })
  @ApiErrorDescriptions({
    ...errors,
    409: 'DISPATCH_NOT_CLAIMED_BY_PROVIDER: el Dispatch no está CLAIMED por mi proveedor (liberado, de otro, cancelado o vencido).',
    429: 'Límite de 20 peticiones/minuto por IP.',
  })
  @ApiOperation({
    summary: 'Liberar Dispatch reclamado por mi proveedor',
    description:
      'Sólo el proveedor que tiene el claim. Mi candidatura pasa a RELEASED (con motivo) y no podrá reclamarlo de nuevo. Dentro de la ventana el Dispatch vuelve a OPEN para los demás candidatos OFFERED (si no queda ninguno sigue OPEN hasta vencer); tras expiresAt pasa a EXPIRED. Liberaciones simultáneas o repetidas: una aplica y el resto recibe 409. 20/min por IP.' +
      PROVIDER_SCOPE_DOC,
  })
  release(
    @Query() _scope: ProviderDispatchScopeDto,
    @CurrentProvider() provider: ProviderProfile,
    @Param('dispatchId', new ParseUUIDPipe()) dispatchId: string,
    @Body() dto: ReleaseDispatchDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.dispatches.release(
      dispatchId,
      provider.id,
      dto.reason,
      req.user.id,
    );
  }

  @Get('service-coverages')
  @ApiOkResponse({ type: ServiceCoverageResponse, isArray: true })
  @ApiErrorDescriptions(errors)
  @ApiOperation({
    summary: 'Consultar coberturas de mi proveedor',
    description:
      'Zonas y tipos de servicio en los que mi proveedor recibe Dispatches. Sólo lectura; las administra SUPER_ADMIN.' +
      PROVIDER_SCOPE_DOC,
  })
  coveragesList(
    @Query() _scope: ProviderDispatchScopeDto,
    @CurrentProvider() provider: ProviderProfile,
  ) {
    return this.coverages.list(provider.id);
  }
}
