import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { IndependentDriversService } from './independent-drivers.service.js';
import {
  ApproveIndependentDriverDto,
  CloseIndependentDriverDto,
  CreateIndependentVehicleDto,
  IndependentDriverListQueryDto,
  UpdateIndependentVehicleDto,
} from './independent-drivers.dto.js';
import {
  IndependentDriverProfilePageResponse,
  IndependentDriverProfileResponse,
  IndependentVehicleResponse,
} from './independent-drivers.responses.js';

const driverParam = ApiParam({
  name: 'driverId',
  format: 'uuid',
  description:
    'Driver.id de un repartidor ya existente (aprovisionado en V1.6.1).',
});
const base = {
  400: 'VALIDATION_ERROR: UUID, motivo o campos inválidos; campos desconocidos rechazados.',
  401: 'Se requiere access JWT humano de un User ACTIVE; un token B2B no es válido.',
  403: 'Rol global distinto de SUPER_ADMIN. PROVIDER_ADMIN y DRIVER no pueden habilitar, suspender ni administrar vehículos independientes.',
  404: 'Driver, perfil independiente o vehículo inexistente.',
  429: 'Límite de peticiones por IP excedido (100/minuto).',
  500: 'Error interno sanitizado.',
};

@ApiTags('Admin Independent Drivers')
@ApiBearerAuth()
@UseGuards(AccessGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller('admin')
export class AdminIndependentDriversController {
  constructor(private readonly independents: IndependentDriversService) {}

  @Get('independent-drivers')
  @ApiOkResponse({ type: IndependentDriverProfilePageResponse })
  @ApiErrorDescriptions(base)
  @ApiOperation({
    summary: 'Listar repartidores independientes',
    description:
      'Perfiles independientes con su Driver, cuenta y número de vehículos propios, del más reciente al más antiguo. Filtrable por estado. Sólo auditoría y administración: SUPER_ADMIN nunca toma servicios en nombre del repartidor.',
  })
  list(@Query() query: IndependentDriverListQueryDto) {
    return this.independents.list(query);
  }

  @Get('drivers/:driverId/independent')
  @driverParam
  @ApiOkResponse({ type: IndependentDriverProfileResponse })
  @ApiErrorDescriptions(base)
  @ApiOperation({
    summary: 'Consultar el perfil independiente de un Driver',
    description:
      'Un Driver sin perfil independiente responde 404: ser repartidor de un proveedor no implica estar habilitado como independiente.',
  })
  get(@Param('driverId', new ParseUUIDPipe()) driverId: string) {
    return this.independents.getByDriver(driverId);
  }

  @Post('drivers/:driverId/independent')
  @HttpCode(200)
  @driverParam
  @ApiOkResponse({ type: IndependentDriverProfileResponse })
  @ApiErrorDescriptions({
    ...base,
    409: 'DRIVER_NOT_ELIGIBLE: el Driver no está ACTIVE, su cuenta no está activa o su rol global no es DRIVER.',
  })
  @ApiOperation({
    summary: 'Habilitar un Driver existente como independiente',
    description:
      'Sólo SUPER_ADMIN. Exige un Driver real y operacional: User ACTIVE con rol DRIVER y Driver ACTIVE. No crea User, Driver ni proveedor ficticio; el aprovisionamiento de cuentas sigue siendo V1.6.1. V1.9 no tiene alta pública, así que el perfil nace APPROVED (PENDING queda reservado para el onboarding futuro). Idempotente: repetir sobre un perfil APPROVED no cambia nada. Reaprobar un perfil SUSPENDED o REJECTED es la forma documentada de rehabilitar. Habilitar no otorga vehículos: hay que darlos de alta aparte.',
  })
  approve(
    @Param('driverId', new ParseUUIDPipe()) driverId: string,
    @Body() dto: ApproveIndependentDriverDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.independents.approve(driverId, dto.reason, {
      userId: req.user.id,
    });
  }

  @Post('drivers/:driverId/independent/suspend')
  @HttpCode(200)
  @driverParam
  @ApiOkResponse({ type: IndependentDriverProfileResponse })
  @ApiErrorDescriptions({
    ...base,
    409: 'INDEPENDENT_DRIVER_HAS_ACTIVE_ASSIGNMENT: el repartidor está ejecutando un servicio.',
  })
  @ApiOperation({
    summary: 'Suspender a un repartidor independiente',
    description:
      'Retira la habilitación con motivo obligatorio. Si el repartidor tiene una asignación ACTIVE responde 409 y no cambia nada: V1.9 prefiere rechazar la suspensión antes que cancelar en silencio una entrega en curso. Para suspenderlo, primero hay que terminar el servicio (el propio repartidor lo libera, o se cancela la DeliveryRequest). La misma regla está forzada en PostgreSQL por independent_driver_profile_guard. Suspender no afecta a su perfil Driver de flotilla ni a sus vehículos.',
  })
  suspend(
    @Param('driverId', new ParseUUIDPipe()) driverId: string,
    @Body() dto: CloseIndependentDriverDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.independents.suspend(driverId, dto.reason, {
      userId: req.user.id,
    });
  }

  @Post('drivers/:driverId/independent/reject')
  @HttpCode(200)
  @driverParam
  @ApiOkResponse({ type: IndependentDriverProfileResponse })
  @ApiErrorDescriptions({
    ...base,
    409: 'INDEPENDENT_DRIVER_HAS_ACTIVE_ASSIGNMENT: el repartidor está ejecutando un servicio.',
  })
  @ApiOperation({
    summary: 'Rechazar el perfil independiente de un Driver',
    description:
      'Cierra la habilitación con motivo obligatorio sin borrar el historial. Misma protección que la suspensión frente a servicios en curso. Se conserva para el onboarding futuro: hoy sólo se aplica a perfiles ya creados por SUPER_ADMIN.',
  })
  reject(
    @Param('driverId', new ParseUUIDPipe()) driverId: string,
    @Body() dto: CloseIndependentDriverDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.independents.reject(driverId, dto.reason, {
      userId: req.user.id,
    });
  }

  @Get('drivers/:driverId/independent/vehicles')
  @driverParam
  @ApiOkResponse({ type: IndependentVehicleResponse, isArray: true })
  @ApiErrorDescriptions(base)
  @ApiOperation({
    summary: 'Vehículos propios del repartidor independiente',
    description:
      'Vehículos cuyo dueño es este perfil independiente. Nunca incluye vehículos de proveedores: la pertenencia es excluyente en la base de datos.',
  })
  listVehicles(@Param('driverId', new ParseUUIDPipe()) driverId: string) {
    return this.independents.listVehicles(driverId);
  }

  @Post('drivers/:driverId/independent/vehicles')
  @driverParam
  @ApiCreatedResponse({ type: IndependentVehicleResponse })
  @ApiErrorDescriptions({
    ...base,
    409: 'VEHICLE_LIMIT_REACHED (INDEPENDENT_DRIVER_MAX_VEHICLES) | identificador repetido en este repartidor.',
  })
  @ApiOperation({
    summary: 'Alta de vehículo propio del repartidor independiente',
    description:
      'Sólo SUPER_ADMIN, siguiendo el patrón de vehículos de proveedor. El dueño se deriva de la ruta, nunca del payload: el vehículo queda con providerId null e independentDriverProfileId del repartidor, y un CHECK impide que tenga ambos o ninguno. El identificador es único dentro del repartidor. V1.9 no implementa verificación documental del vehículo.',
  })
  createVehicle(
    @Param('driverId', new ParseUUIDPipe()) driverId: string,
    @Body() dto: CreateIndependentVehicleDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.independents.createVehicle(driverId, dto, {
      userId: req.user.id,
    });
  }

  @Patch('drivers/:driverId/independent/vehicles/:vehicleId')
  @driverParam
  @ApiParam({ name: 'vehicleId', format: 'uuid' })
  @ApiOkResponse({ type: IndependentVehicleResponse })
  @ApiErrorDescriptions({
    ...base,
    409: 'VEHICLE_HAS_ACTIVE_ASSIGNMENT: el vehículo está ejecutando un servicio.',
  })
  @ApiOperation({
    summary: 'Editar o cambiar el estado de un vehículo independiente',
    description:
      'Edita detalles o el estado operativo. Desactivar (INACTIVE, MAINTENANCE o SUSPENDED) un vehículo con asignación ACTIVE responde 409 y no cambia nada, por la misma razón que la suspensión del repartidor: no dejar una entrega en curso apuntando a un vehículo inutilizable. El dueño del vehículo no se puede cambiar (trigger Vehicle_owner_guard).',
  })
  updateVehicle(
    @Param('driverId', new ParseUUIDPipe()) driverId: string,
    @Param('vehicleId', new ParseUUIDPipe()) vehicleId: string,
    @Body() dto: UpdateIndependentVehicleDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.independents.updateVehicle(driverId, vehicleId, dto, {
      userId: req.user.id,
    });
  }
}
