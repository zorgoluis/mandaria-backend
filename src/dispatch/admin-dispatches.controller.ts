import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { AccessGuard, Roles, RolesGuard } from '../auth/auth.guards.js';
import type { AuthenticatedRequest } from '../auth/auth.guards.js';
import { ApiErrorDescriptions } from '../common/api-errors.decorator.js';
import { DispatchService } from './dispatch.service.js';
import { ProviderCoveragesService } from './provider-coverages.service.js';
import {
  AdminDispatchListQueryDto,
  CreateServiceCoverageDto,
  UpdateServiceCoverageDto,
} from './dispatch.dto.js';
import {
  AdminDispatchPageResponse,
  AdminDispatchResponse,
  ServiceCoverageResponse,
} from './dispatch.responses.js';

const errors = {
  400: 'VALIDATION_ERROR: UUID, filtros o campos inválidos.',
  401: 'Se requiere access JWT humano; un token B2B no es válido.',
  403: 'Sólo SUPER_ADMIN.',
  404: 'Proveedor, zona, cobertura o Dispatch no encontrado.',
  429: 'Límite de peticiones por IP excedido (100/minuto).',
  500: 'Error interno sanitizado.',
};
const providerParam = ApiParam({ name: 'providerId', format: 'uuid' });

@ApiTags('Admin Dispatch')
@ApiBearerAuth()
@UseGuards(AccessGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller('admin')
export class AdminDispatchesController {
  constructor(
    private readonly dispatches: DispatchService,
    private readonly coverages: ProviderCoveragesService,
  ) {}

  @Get('dispatches')
  @ApiOkResponse({ type: AdminDispatchPageResponse })
  @ApiErrorDescriptions(errors)
  @ApiOperation({
    summary: 'Listar Dispatches',
    description:
      'Sólo SUPER_ADMIN (lectura y auditoría). Filtros status efectivo, providerId (candidato) y deliveryRequestPublicId. Incluye candidatos con su estado y la señal derivada noProviderAvailable. SUPER_ADMIN no reclama ni libera: no actúa como proveedor. Los Dispatch se cancelan con la DeliveryRequest (POST /admin/delivery-requests/:publicId/cancel).',
  })
  list(@Query() query: AdminDispatchListQueryDto) {
    return this.dispatches.listForAdmin(query);
  }

  @Get('dispatches/:dispatchId')
  @ApiParam({ name: 'dispatchId', format: 'uuid' })
  @ApiOkResponse({ type: AdminDispatchResponse })
  @ApiErrorDescriptions(errors)
  @ApiOperation({
    summary: 'Consultar Dispatch',
    description:
      'Sólo SUPER_ADMIN. Snapshot de candidatos (a quién se ofreció), claim, liberaciones con motivo y cancelación.',
  })
  get(@Param('dispatchId', new ParseUUIDPipe()) dispatchId: string) {
    return this.dispatches.getForAdmin(dispatchId);
  }

  @Post('providers/:providerId/service-coverages')
  @providerParam
  @ApiCreatedResponse({ type: ServiceCoverageResponse })
  @ApiErrorDescriptions({
    ...errors,
    409: 'SERVICE_COVERAGE_EXISTS: el proveedor ya tiene cobertura para esa zona y tipo de servicio (reactivarla con PATCH).',
  })
  @ApiOperation({
    summary: 'Habilitar proveedor en zona y tipo de servicio',
    description:
      'Sólo SUPER_ADMIN. Nace ACTIVE. Un proveedor recibe Dispatches cuando está ACTIVE y tiene cobertura ACTIVE para la ServiceZone y el ServiceType de la Quote aceptada. No afecta Dispatches ya abiertos (snapshot).',
  })
  createCoverage(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Body() dto: CreateServiceCoverageDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.coverages.create(providerId, dto, req.user.id);
  }

  @Get('providers/:providerId/service-coverages')
  @providerParam
  @ApiOkResponse({ type: ServiceCoverageResponse, isArray: true })
  @ApiErrorDescriptions(errors)
  @ApiOperation({
    summary: 'Listar coberturas del proveedor',
    description:
      'Sólo SUPER_ADMIN. Zonas y tipos de servicio (ACTIVE e INACTIVE) que determinan en qué Dispatches es candidato el proveedor. Proveedor inexistente responde 404.',
  })
  listCoverages(@Param('providerId', new ParseUUIDPipe()) providerId: string) {
    return this.coverages.list(providerId, true);
  }

  @Patch('providers/:providerId/service-coverages/:coverageId')
  @providerParam
  @ApiParam({ name: 'coverageId', format: 'uuid' })
  @ApiOkResponse({ type: ServiceCoverageResponse })
  @ApiErrorDescriptions(errors)
  @ApiOperation({
    summary: 'Activar o desactivar cobertura',
    description:
      'Sólo SUPER_ADMIN. INACTIVE excluye al proveedor de nuevos Dispatches de esa zona/servicio y hace fallar sus claims pendientes con PROVIDER_NOT_ELIGIBLE. No borra historial.',
  })
  updateCoverage(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Param('coverageId', new ParseUUIDPipe()) coverageId: string,
    @Body() dto: UpdateServiceCoverageDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.coverages.setStatus(
      providerId,
      coverageId,
      dto.status,
      req.user.id,
    );
  }
}
