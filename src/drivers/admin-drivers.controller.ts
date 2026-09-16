import {
  Body,
  Controller,
  Delete,
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
import { DriversService } from './drivers.service.js';
import {
  AssignVehicleDto,
  CreateDriverDto,
  DriverListQueryDto,
  UpdateDriverDto,
} from './drivers.dto.js';
import {
  AssignmentPageResponse,
  AssignmentResponse,
  DriverPageResponse,
  DriverResponse,
} from './logistics.responses.js';

const providerParam = ApiParam({
  name: 'providerId',
  format: 'uuid',
  description: 'DeliveryProvider.id; cualquier proveedor existente.',
});
const driverParam = ApiParam({
  name: 'driverId',
  format: 'uuid',
  description: 'Driver.id perteneciente a providerId; de otro proveedor → 404.',
});

@ApiTags('Admin Drivers')
@ApiBearerAuth()
@ApiErrors(400, 401, 403, 404, 429, 500)
@UseGuards(AccessGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller('admin/providers/:providerId/drivers')
export class AdminDriversController {
  constructor(
    private readonly drivers: DriversService,
    private readonly assignments: AssignmentsService,
  ) {}
  @Post()
  @providerParam
  @ApiCreatedResponse({ type: DriverResponse })
  @ApiErrors(409)
  @ApiOperation({
    summary: 'Crear Driver para un User DRIVER existente',
    description:
      'Sólo SUPER_ADMIN. userId debe ser un User activo con rol global DRIVER y sin otro perfil Driver. Nace PENDING/OFFLINE. Respeta maxDrivers contando todos los Drivers existentes del proveedor (409 al alcanzarlo), con bloqueo transaccional del proveedor.',
  })
  create(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Body() dto: CreateDriverDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.drivers.create(providerId, dto, req.user.id);
  }
  @Get()
  @providerParam
  @ApiOkResponse({ type: DriverPageResponse })
  @ApiOperation({
    summary: 'Listar Drivers del proveedor',
    description:
      'Sólo SUPER_ADMIN. Filtros status, availability y search (nombre o email). Paginación page/pageSize (máx. 100) y orden createdAt DESC, id DESC. Incluye la asignación vigente sin consultas por fila. Proveedor inexistente → 404.',
  })
  list(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Query() query: DriverListQueryDto,
  ) {
    return this.drivers.list(providerId, query, true);
  }
  @Get(':driverId')
  @providerParam
  @driverParam
  @ApiOkResponse({ type: DriverResponse })
  @ApiOperation({
    summary: 'Consultar Driver',
    description:
      'Sólo SUPER_ADMIN. Devuelve perfil logístico, User público (sin secretos) y asignación vigente. Un Driver de otro proveedor responde 404.',
  })
  get(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Param('driverId', new ParseUUIDPipe()) driverId: string,
  ) {
    return this.drivers.get(providerId, driverId);
  }
  @Patch(':driverId')
  @providerParam
  @driverParam
  @ApiOkResponse({ type: DriverResponse })
  @ApiErrors(409)
  @ApiOperation({
    summary: 'Editar nombre o estado del Driver',
    description:
      'Sólo SUPER_ADMIN. Requiere name o status. Transiciones PENDING→ACTIVE/SUSPENDED, ACTIVE→SUSPENDED, SUSPENDED→ACTIVE; otras 409. Salir de ACTIVE fuerza OFFLINE. No cambia User.role ni la asignación vigente.',
  })
  update(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Param('driverId', new ParseUUIDPipe()) driverId: string,
    @Body() dto: UpdateDriverDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.drivers.update(providerId, driverId, dto, req.user.id);
  }
  @Post(':driverId/vehicle')
  @providerParam
  @driverParam
  @ApiCreatedResponse({ type: AssignmentResponse })
  @ApiErrors(409)
  @ApiOperation({
    summary: 'Asignar vehículo al Driver',
    description:
      'Sólo SUPER_ADMIN. Vehicle ACTIVE del mismo proveedor (otro proveedor → 404). 409 si el Driver está SUSPENDED, el proveedor SUSPENDED, el Driver ya tiene vehículo o el vehículo ya está ocupado. PENDING puede recibir vehículo.',
  })
  assign(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Param('driverId', new ParseUUIDPipe()) driverId: string,
    @Body() dto: AssignVehicleDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.assignments.assign(
      providerId,
      driverId,
      dto.vehicleId,
      req.user.id,
    );
  }
  @Delete(':driverId/vehicle')
  @providerParam
  @driverParam
  @ApiOkResponse({ type: AssignmentResponse })
  @ApiOperation({
    summary: 'Desasignar vehículo vigente',
    description:
      'Sólo SUPER_ADMIN. Cierra la asignación activa con unassignedAt y devuelve el registro cerrado; el historial se conserva. Sin asignación activa responde 404.',
  })
  unassign(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Param('driverId', new ParseUUIDPipe()) driverId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.assignments.unassign(providerId, driverId, req.user.id);
  }
  @Get(':driverId/assignments')
  @providerParam
  @driverParam
  @ApiOkResponse({ type: AssignmentPageResponse })
  @ApiOperation({
    summary: 'Historial de vehículos del Driver',
    description:
      'Sólo SUPER_ADMIN. Asignaciones vigentes y cerradas, paginadas y ordenadas por assignedAt DESC. Cada fila incluye sólo identificadores resumidos de Driver y Vehicle.',
  })
  history(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Param('driverId', new ParseUUIDPipe()) driverId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.assignments.history(providerId, { driverId }, query);
  }
}
