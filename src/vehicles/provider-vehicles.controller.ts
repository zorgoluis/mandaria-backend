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
import { ApiErrors } from '../common/api-errors.decorator.js';
import { AssignmentsService } from '../assignments/assignments.service.js';
import {
  CurrentProvider,
  ProviderMembershipGuard,
} from '../providers/provider-membership.guard.js';
import type { ProviderProfile } from '../providers/provider-membership.guard.js';
import { ProviderProfileQueryDto } from '../providers/providers.dto.js';
import { ProviderScopedPaginationQueryDto } from '../drivers/drivers.dto.js';
import { PROVIDER_SCOPE_DOC } from '../drivers/provider-drivers.controller.js';
import {
  AssignmentPageResponse,
  VehiclePageResponse,
  VehicleResponse,
} from '../drivers/logistics.responses.js';
import { VehiclesService } from './vehicles.service.js';
import {
  CreateVehicleDto,
  ProviderVehicleListQueryDto,
  UpdateVehicleDto,
} from './vehicles.dto.js';

const vehicleParam = ApiParam({
  name: 'vehicleId',
  format: 'uuid',
  description:
    'Vehicle.id del proveedor autorizado; un vehículo de otro proveedor responde 404.',
});

@ApiTags('Provider Vehicles')
@ApiBearerAuth()
@ApiErrors(400, 401, 403, 404, 409, 429, 500)
// Order matters: authenticate → global role → membership. Membership never replaces the role check.
@UseGuards(AccessGuard, RolesGuard, ProviderMembershipGuard)
@Roles('PROVIDER_ADMIN')
@Controller('provider/vehicles')
export class ProviderVehiclesController {
  constructor(
    private readonly vehicles: VehiclesService,
    private readonly assignments: AssignmentsService,
  ) {}
  @Post()
  @ApiCreatedResponse({ type: VehicleResponse })
  @ApiOperation({
    summary: 'Crear vehículo en mi proveedor',
    description:
      'identifier único dentro del proveedor; respeta maxVehicles contando todos los estados (409).' +
      PROVIDER_SCOPE_DOC,
  })
  create(
    @Query() _scope: ProviderProfileQueryDto,
    @CurrentProvider() provider: ProviderProfile,
    @Body() dto: CreateVehicleDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.vehicles.create(provider.id, dto, req.user.id);
  }
  @Get()
  @ApiOkResponse({ type: VehiclePageResponse })
  @ApiOperation({
    summary: 'Listar vehículos de mi proveedor',
    description:
      'Filtros type, status y search; paginación page/pageSize. Nunca incluye vehículos de otros proveedores.' +
      PROVIDER_SCOPE_DOC,
  })
  list(
    @Query() query: ProviderVehicleListQueryDto,
    @CurrentProvider() provider: ProviderProfile,
  ) {
    return this.vehicles.list(provider.id, query);
  }
  @Get(':vehicleId')
  @vehicleParam
  @ApiOkResponse({ type: VehicleResponse })
  @ApiOperation({
    summary: 'Consultar vehículo de mi proveedor',
    description:
      'Datos del vehículo y Driver que lo usa actualmente.' +
      PROVIDER_SCOPE_DOC,
  })
  get(
    @Query() _scope: ProviderProfileQueryDto,
    @CurrentProvider() provider: ProviderProfile,
    @Param('vehicleId', new ParseUUIDPipe()) vehicleId: string,
  ) {
    return this.vehicles.get(provider.id, vehicleId);
  }
  @Patch(':vehicleId')
  @vehicleParam
  @ApiOkResponse({ type: VehicleResponse })
  @ApiOperation({
    summary: 'Editar vehículo de mi proveedor',
    description:
      'Datos descriptivos (null para limpiar) y estado; sólo ACTIVE admite nuevas asignaciones.' +
      PROVIDER_SCOPE_DOC,
  })
  update(
    @Query() _scope: ProviderProfileQueryDto,
    @CurrentProvider() provider: ProviderProfile,
    @Param('vehicleId', new ParseUUIDPipe()) vehicleId: string,
    @Body() dto: UpdateVehicleDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.vehicles.update(provider.id, vehicleId, dto, req.user.id);
  }
  @Get(':vehicleId/assignments')
  @vehicleParam
  @ApiOkResponse({ type: AssignmentPageResponse })
  @ApiOperation({
    summary: 'Historial de Drivers del vehículo',
    description:
      'Asignaciones vigentes y cerradas del vehículo, paginadas por assignedAt DESC.' +
      PROVIDER_SCOPE_DOC,
  })
  history(
    @Query() query: ProviderScopedPaginationQueryDto,
    @CurrentProvider() provider: ProviderProfile,
    @Param('vehicleId', new ParseUUIDPipe()) vehicleId: string,
  ) {
    return this.assignments.history(provider.id, { vehicleId }, query);
  }
}
