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
import { PaginationQueryDto } from '../common/pagination.dto.js';
import { AssignmentsService } from '../assignments/assignments.service.js';
import {
  AssignmentPageResponse,
  VehiclePageResponse,
  VehicleResponse,
} from '../drivers/logistics.responses.js';
import { VehiclesService } from './vehicles.service.js';
import {
  CreateVehicleDto,
  UpdateVehicleDto,
  VehicleListQueryDto,
} from './vehicles.dto.js';

const providerParam = ApiParam({
  name: 'providerId',
  format: 'uuid',
  description: 'DeliveryProvider.id; cualquier proveedor existente.',
});
const vehicleParam = ApiParam({
  name: 'vehicleId',
  format: 'uuid',
  description:
    'Vehicle.id perteneciente a providerId; de otro proveedor → 404.',
});

@ApiTags('Admin Vehicles')
@ApiBearerAuth()
@ApiErrors(400, 401, 403, 404, 429, 500)
@UseGuards(AccessGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller('admin/providers/:providerId/vehicles')
export class AdminVehiclesController {
  constructor(
    private readonly vehicles: VehiclesService,
    private readonly assignments: AssignmentsService,
  ) {}
  @Post()
  @providerParam
  @ApiCreatedResponse({ type: VehicleResponse })
  @ApiErrors(409)
  @ApiOperation({
    summary: 'Crear vehículo del proveedor',
    description:
      'Sólo SUPER_ADMIN. identifier único dentro del proveedor (409 si se repite), type genérico y placa opcional. Respeta maxVehicles contando todos los vehículos existentes en cualquier estado, con bloqueo transaccional del proveedor.',
  })
  create(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Body() dto: CreateVehicleDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.vehicles.create(providerId, dto, req.user.id);
  }
  @Get()
  @providerParam
  @ApiOkResponse({ type: VehiclePageResponse })
  @ApiOperation({
    summary: 'Listar vehículos del proveedor',
    description:
      'Sólo SUPER_ADMIN. Filtros type, status y search (identifier, placa, marca, modelo). Paginación page/pageSize y orden createdAt DESC, id DESC. Incluye Driver vigente. Proveedor inexistente → 404.',
  })
  list(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Query() query: VehicleListQueryDto,
  ) {
    return this.vehicles.list(providerId, query, true);
  }
  @Get(':vehicleId')
  @providerParam
  @vehicleParam
  @ApiOkResponse({ type: VehicleResponse })
  @ApiOperation({
    summary: 'Consultar vehículo',
    description:
      'Sólo SUPER_ADMIN. Datos del vehículo y Driver que lo utiliza actualmente (currentAssignment o null).',
  })
  get(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Param('vehicleId', new ParseUUIDPipe()) vehicleId: string,
  ) {
    return this.vehicles.get(providerId, vehicleId);
  }
  @Patch(':vehicleId')
  @providerParam
  @vehicleParam
  @ApiOkResponse({ type: VehicleResponse })
  @ApiErrors(409)
  @ApiOperation({
    summary: 'Editar datos o estado del vehículo',
    description:
      'Sólo SUPER_ADMIN. Campos omitidos se conservan; brand/model/year/color/plate aceptan null. Status libre entre ACTIVE/INACTIVE/MAINTENANCE/SUSPENDED; no cierra la asignación vigente pero sólo ACTIVE admite nuevas.',
  })
  update(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Param('vehicleId', new ParseUUIDPipe()) vehicleId: string,
    @Body() dto: UpdateVehicleDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.vehicles.update(providerId, vehicleId, dto, req.user.id);
  }
  @Get(':vehicleId/assignments')
  @providerParam
  @vehicleParam
  @ApiOkResponse({ type: AssignmentPageResponse })
  @ApiOperation({
    summary: 'Historial de Drivers del vehículo',
    description:
      'Sólo SUPER_ADMIN. Asignaciones vigentes y cerradas del vehículo, paginadas y ordenadas por assignedAt DESC.',
  })
  history(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Param('vehicleId', new ParseUUIDPipe()) vehicleId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.assignments.history(providerId, { vehicleId }, query);
  }
}
