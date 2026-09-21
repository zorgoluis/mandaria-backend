import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AccessGuard, Roles, RolesGuard } from '../auth/auth.guards.js';
import type { AuthenticatedRequest } from '../auth/auth.guards.js';
import { ApiErrors } from '../common/api-errors.decorator.js';
import { DriversService } from './drivers.service.js';
import { UpdateAvailabilityDto } from './drivers.dto.js';
import { DriverSelfResponse } from './logistics.responses.js';

@ApiTags('Driver')
@ApiBearerAuth()
@ApiErrors(400, 401, 403, 404, 429, 500)
@UseGuards(AccessGuard, RolesGuard)
@Roles('DRIVER')
@Controller('driver')
export class DriverSelfController {
  constructor(private readonly drivers: DriversService) {}
  @Get('me')
  @ApiOkResponse({ type: DriverSelfResponse })
  @ApiOperation({
    summary: 'Consultar mi perfil de repartidor',
    description:
      'Sólo User activo con rol global DRIVER. Resuelve User → Driver → Provider → vehículo vigente desde el JWT; no acepta IDs. Sin perfil Driver responde 404. Drivers o proveedores suspendidos siguen consultables. V1.9 agrega `independent` (capacidad de operar por cuenta propia, null si Mandaria no la habilitó) y `activeDeliveryAssignment` (el servicio que ejecuta ahora en cualquiera de los dos modelos).',
  })
  me(@Req() req: AuthenticatedRequest) {
    return this.drivers.self(req.user.id);
  }
  @Patch('availability')
  @ApiOkResponse({ type: DriverSelfResponse })
  @ApiErrors(409)
  @ApiOperation({
    summary: 'Cambiar mi disponibilidad',
    description:
      'Sólo modifica al Driver del JWT; enviar driverId u otros campos devuelve 400. OFFLINE siempre permitido; AVAILABLE/BUSY requieren Driver ACTIVE y proveedor ACTIVE (409). No asigna entregas.',
  })
  availability(
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpdateAvailabilityDto,
  ) {
    return this.drivers.setOwnAvailability(req.user.id, dto.availability);
  }
}
