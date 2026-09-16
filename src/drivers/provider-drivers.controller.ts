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
import { AssignmentsService } from '../assignments/assignments.service.js';
import {
  CurrentProvider,
  ProviderMembershipGuard,
} from '../providers/provider-membership.guard.js';
import type { ProviderProfile } from '../providers/provider-membership.guard.js';
import { ProviderProfileQueryDto } from '../providers/providers.dto.js';
import { DriversService } from './drivers.service.js';
import {
  AssignVehicleDto,
  CreateDriverDto,
  ProviderDriverListQueryDto,
  ProviderScopedPaginationQueryDto,
  UpdateDriverDto,
} from './drivers.dto.js';
import {
  AssignmentPageResponse,
  AssignmentResponse,
  DriverPageResponse,
  DriverResponse,
} from './logistics.responses.js';

const driverParam = ApiParam({
  name: 'driverId',
  format: 'uuid',
  description:
    'Driver.id del proveedor autorizado; un Driver de otro proveedor responde 404.',
});
export const PROVIDER_SCOPE_DOC =
  ' Requiere JWT humano, rol global PROVIDER_ADMIN (RolesGuard) y membership vigente (ProviderMembershipGuard); son comprobaciones independientes. providerId es opcional sólo con una membership; un proveedor sin membership responde 403.';

@ApiTags('Provider Drivers')
@ApiBearerAuth()
@ApiErrors(400, 401, 403, 404, 409, 429, 500)
// Order matters: authenticate → global role → membership. Membership never replaces the role check.
@UseGuards(AccessGuard, RolesGuard, ProviderMembershipGuard)
@Roles('PROVIDER_ADMIN')
@Controller('provider/drivers')
export class ProviderDriversController {
  constructor(
    private readonly drivers: DriversService,
    private readonly assignments: AssignmentsService,
  ) {}
  @Post()
  @ApiCreatedResponse({ type: DriverResponse })
  @ApiOperation({
    summary: 'Crear Driver en mi proveedor',
    description:
      'userId debe ser un User activo con rol DRIVER sin perfil Driver. Nace PENDING/OFFLINE y respeta maxDrivers (409).' +
      PROVIDER_SCOPE_DOC,
  })
  create(
    @Query() _scope: ProviderProfileQueryDto,
    @CurrentProvider() provider: ProviderProfile,
    @Body() dto: CreateDriverDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.drivers.create(provider.id, dto, req.user.id);
  }
  @Get()
  @ApiOkResponse({ type: DriverPageResponse })
  @ApiOperation({
    summary: 'Listar Drivers de mi proveedor',
    description:
      'Filtros status, availability y search; paginación page/pageSize. Nunca incluye Drivers de otros proveedores.' +
      PROVIDER_SCOPE_DOC,
  })
  list(
    @Query() query: ProviderDriverListQueryDto,
    @CurrentProvider() provider: ProviderProfile,
  ) {
    return this.drivers.list(provider.id, query);
  }
  @Get(':driverId')
  @driverParam
  @ApiOkResponse({ type: DriverResponse })
  @ApiOperation({
    summary: 'Consultar Driver de mi proveedor',
    description:
      'Perfil logístico, User público y asignación vigente.' +
      PROVIDER_SCOPE_DOC,
  })
  get(
    @Query() _scope: ProviderProfileQueryDto,
    @CurrentProvider() provider: ProviderProfile,
    @Param('driverId', new ParseUUIDPipe()) driverId: string,
  ) {
    return this.drivers.get(provider.id, driverId);
  }
  @Patch(':driverId')
  @driverParam
  @ApiOkResponse({ type: DriverResponse })
  @ApiOperation({
    summary: 'Editar nombre o estado de un Driver de mi proveedor',
    description:
      'Mismas transiciones que SUPER_ADMIN; salir de ACTIVE fuerza OFFLINE. No cambia User.role.' +
      PROVIDER_SCOPE_DOC,
  })
  update(
    @Query() _scope: ProviderProfileQueryDto,
    @CurrentProvider() provider: ProviderProfile,
    @Param('driverId', new ParseUUIDPipe()) driverId: string,
    @Body() dto: UpdateDriverDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.drivers.update(provider.id, driverId, dto, req.user.id);
  }
  @Post(':driverId/vehicle')
  @driverParam
  @ApiCreatedResponse({ type: AssignmentResponse })
  @ApiOperation({
    summary: 'Asignar vehículo de mi proveedor',
    description:
      'Vehicle ACTIVE, libre y del mismo proveedor (otro proveedor → 404). 409 si Driver o proveedor están SUSPENDED o si Driver/Vehicle ya tienen asignación vigente.' +
      PROVIDER_SCOPE_DOC,
  })
  assign(
    @Query() _scope: ProviderProfileQueryDto,
    @CurrentProvider() provider: ProviderProfile,
    @Param('driverId', new ParseUUIDPipe()) driverId: string,
    @Body() dto: AssignVehicleDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.assignments.assign(
      provider.id,
      driverId,
      dto.vehicleId,
      req.user.id,
    );
  }
  @Delete(':driverId/vehicle')
  @driverParam
  @ApiOkResponse({ type: AssignmentResponse })
  @ApiOperation({
    summary: 'Desasignar vehículo vigente',
    description:
      'Cierra la asignación activa conservando historial; sin asignación activa responde 404.' +
      PROVIDER_SCOPE_DOC,
  })
  unassign(
    @Query() _scope: ProviderProfileQueryDto,
    @CurrentProvider() provider: ProviderProfile,
    @Param('driverId', new ParseUUIDPipe()) driverId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.assignments.unassign(provider.id, driverId, req.user.id);
  }
  @Get(':driverId/assignments')
  @driverParam
  @ApiOkResponse({ type: AssignmentPageResponse })
  @ApiOperation({
    summary: 'Historial de vehículos del Driver',
    description:
      'Asignaciones vigentes y cerradas, paginadas por assignedAt DESC.' +
      PROVIDER_SCOPE_DOC,
  })
  history(
    @Query() query: ProviderScopedPaginationQueryDto,
    @CurrentProvider() provider: ProviderProfile,
    @Param('driverId', new ParseUUIDPipe()) driverId: string,
  ) {
    return this.assignments.history(provider.id, { driverId }, query);
  }
}
