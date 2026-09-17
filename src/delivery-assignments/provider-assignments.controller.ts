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
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { AccessGuard, Roles, RolesGuard } from '../auth/auth.guards.js';
import type { AuthenticatedRequest } from '../auth/auth.guards.js';
import { ApiErrorDescriptions } from '../common/api-errors.decorator.js';
import {
  CurrentProvider,
  ProviderMembershipGuard,
} from '../providers/provider-membership.guard.js';
import type { ProviderProfile } from '../providers/provider-membership.guard.js';
import { PROVIDER_SCOPE_DOC } from '../drivers/provider-drivers.controller.js';
import { DeliveryAssignmentsService } from './delivery-assignments.service.js';
import {
  CancelDeliveryAssignmentDto,
  CreateDeliveryAssignmentDto,
  ProviderScopeDto,
  ProviderScopedPageDto,
  ReassignDeliveryAssignmentDto,
} from './delivery-assignments.dto.js';
import {
  AvailableDriverPageResponse,
  AvailableVehiclePageResponse,
  DeliveryAssignmentResponse,
  DeliveryAssignmentWithPaymentResponse,
} from './delivery-assignments.responses.js';

const dispatchParam = ApiParam({
  name: 'dispatchId',
  format: 'uuid',
  description:
    'Dispatch.id. Si mi proveedor no fue candidato responde 404 igual que un id inexistente.',
});
const base = {
  400: 'VALIDATION_ERROR: UUID, motivo o campos inválidos; campos desconocidos rechazados.',
  401: 'Se requiere access JWT humano de un User ACTIVE; un token B2B no es válido.',
  403: 'Rol global distinto de PROVIDER_ADMIN (SUPER_ADMIN y DRIVER incluidos) o sin membership en el providerId indicado.',
  404: 'Dispatch, Driver o Vehicle inexistente o de otro proveedor.',
  429: 'Límite de peticiones por IP excedido (100/minuto).',
  500: 'Error interno sanitizado.',
};
const conflicts =
  'DISPATCH_NOT_CLAIMED_BY_PROVIDER (el Dispatch no está CLAIMED por mi proveedor) | PROVIDER_NOT_ACTIVE | DRIVER_NOT_ELIGIBLE (no ACTIVE o cuenta inactiva) | VEHICLE_NOT_ELIGIBLE | DRIVER_BUSY | VEHICLE_BUSY (ya tienen una asignación ACTIVE) | DRIVER_VEHICLE_MISMATCH (contradice el emparejamiento V1.4) | ASSIGNMENT_CONFLICT.';

@ApiTags('Provider Delivery Assignments')
@ApiBearerAuth()
@UseGuards(AccessGuard, RolesGuard, ProviderMembershipGuard)
@Roles('PROVIDER_ADMIN')
@Controller('provider/dispatches')
export class ProviderAssignmentsController {
  constructor(private readonly assignments: DeliveryAssignmentsService) {}

  @Post(':dispatchId/assignment')
  @dispatchParam
  @ApiCreatedResponse({ type: DeliveryAssignmentWithPaymentResponse })
  @ApiErrorDescriptions({
    ...base,
    409: `${conflicts} DISPATCH_ALREADY_ASSIGNED (ya hay una asignación ACTIVE: usar reassign).`,
  })
  @ApiOperation({
    summary: 'Asignar Driver y Vehicle a mi Dispatch',
    description:
      'Sólo el proveedor que tiene el claim. El proveedor se deriva de la membership y del Dispatch, nunca del payload. Comprueba bajo bloqueos (Dispatch → proveedor → Driver → Vehicle) que el Dispatch siga CLAIMED por mí y que Driver y Vehicle sean míos, operacionales, libres y coherentes con el emparejamiento V1.4. Máximo una asignación ACTIVE por Dispatch, Driver y Vehicle (índices únicos parciales). Devuelve el contexto de pago: si goodsPaymentMode es COURIER_ADVANCE, driverAdvanceAmount indica cuánto debe adelantar el repartidor al comercio. No cambia el estado del Dispatch ni asigna disponibilidad del Driver.' +
      PROVIDER_SCOPE_DOC,
  })
  create(
    @Query() _scope: ProviderScopeDto,
    @CurrentProvider() provider: ProviderProfile,
    @Param('dispatchId', new ParseUUIDPipe()) dispatchId: string,
    @Body() dto: CreateDeliveryAssignmentDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.assignments.create(dispatchId, dto, {
      providerId: provider.id,
      userId: req.user.id,
    });
  }

  @Post(':dispatchId/assignment/reassign')
  @HttpCode(200)
  @dispatchParam
  @ApiOkResponse({ type: DeliveryAssignmentWithPaymentResponse })
  @ApiErrorDescriptions({
    ...base,
    409: `${conflicts} NO_ACTIVE_ASSIGNMENT | ASSIGNMENT_UNCHANGED (mismo Driver y Vehicle).`,
  })
  @ApiOperation({
    summary: 'Reasignar Driver y Vehicle',
    description:
      'En una sola transacción la asignación ACTIVE pasa a REASSIGNED (con motivo) y se crea la nueva ACTIVE: nunca hay dos activas ni se pierde el historial, que no se sobrescribe. Se permite cambiar sólo el Driver o sólo el Vehicle; repetir exactamente la misma pareja responde 409 ASSIGNMENT_UNCHANGED.' +
      PROVIDER_SCOPE_DOC,
  })
  reassign(
    @Query() _scope: ProviderScopeDto,
    @CurrentProvider() provider: ProviderProfile,
    @Param('dispatchId', new ParseUUIDPipe()) dispatchId: string,
    @Body() dto: ReassignDeliveryAssignmentDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.assignments.reassign(dispatchId, dto, {
      providerId: provider.id,
      userId: req.user.id,
    });
  }

  @Post(':dispatchId/assignment/cancel')
  @HttpCode(200)
  @dispatchParam
  @ApiOkResponse({ type: DeliveryAssignmentWithPaymentResponse })
  @ApiErrorDescriptions({
    ...base,
    409: 'DISPATCH_NOT_CLAIMED_BY_PROVIDER | NO_ACTIVE_ASSIGNMENT.',
  })
  @ApiOperation({
    summary: 'Liberar Driver y Vehicle sin reemplazo',
    description:
      'La asignación ACTIVE pasa a CANCELLED con motivo y el Driver y el Vehicle quedan libres. Es el paso previo obligatorio para liberar el Dispatch: con una asignación ACTIVE, POST /provider/dispatches/:id/release responde 409 DISPATCH_HAS_ACTIVE_ASSIGNMENT.' +
      PROVIDER_SCOPE_DOC,
  })
  cancel(
    @Query() _scope: ProviderScopeDto,
    @CurrentProvider() provider: ProviderProfile,
    @Param('dispatchId', new ParseUUIDPipe()) dispatchId: string,
    @Body() dto: CancelDeliveryAssignmentDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.assignments.cancel(dispatchId, dto, {
      providerId: provider.id,
      userId: req.user.id,
    });
  }

  @Get(':dispatchId/assignments')
  @dispatchParam
  @ApiOkResponse({ type: DeliveryAssignmentResponse, isArray: true })
  @ApiErrorDescriptions(base)
  @ApiOperation({
    summary: 'Historial de asignaciones de mi proveedor',
    description:
      'Asignaciones de mi proveedor en ese Dispatch, de la más reciente a la más antigua, con Driver, Vehicle, quién asignó y terminó, motivo y fechas. Nunca incluye asignaciones de otros proveedores ni datos del cliente.' +
      PROVIDER_SCOPE_DOC,
  })
  history(
    @Query() _scope: ProviderScopeDto,
    @CurrentProvider() provider: ProviderProfile,
    @Param('dispatchId', new ParseUUIDPipe()) dispatchId: string,
  ) {
    return this.assignments.historyForProvider(dispatchId, provider.id);
  }

  @Get(':dispatchId/available-drivers')
  @dispatchParam
  @ApiOkResponse({ type: AvailableDriverPageResponse })
  @ApiErrorDescriptions({
    ...base,
    409: 'DISPATCH_NOT_CLAIMED_BY_PROVIDER.',
  })
  @ApiOperation({
    summary: 'Drivers asignables para mi Dispatch',
    description:
      'Drivers de mi proveedor ACTIVE, con cuenta activa y sin asignación de entrega ACTIVE, con su vehículo emparejado en V1.4 si lo tienen. V1.8 no exige disponibilidad AVAILABLE, GPS ni app conectada. Paginado.' +
      PROVIDER_SCOPE_DOC,
  })
  availableDrivers(
    @Query() query: ProviderScopedPageDto,
    @CurrentProvider() provider: ProviderProfile,
    @Param('dispatchId', new ParseUUIDPipe()) dispatchId: string,
  ) {
    return this.assignments.availableDrivers(dispatchId, provider.id, query);
  }

  @Get(':dispatchId/available-vehicles')
  @dispatchParam
  @ApiOkResponse({ type: AvailableVehiclePageResponse })
  @ApiErrorDescriptions({
    ...base,
    409: 'DISPATCH_NOT_CLAIMED_BY_PROVIDER.',
  })
  @ApiOperation({
    summary: 'Vehicles asignables para mi Dispatch',
    description:
      'Vehicles ACTIVE de mi proveedor sin asignación de entrega ACTIVE, con su Driver emparejado en V1.4 si lo tienen. Paginado.' +
      PROVIDER_SCOPE_DOC,
  })
  availableVehicles(
    @Query() query: ProviderScopedPageDto,
    @CurrentProvider() provider: ProviderProfile,
    @Param('dispatchId', new ParseUUIDPipe()) dispatchId: string,
  ) {
    return this.assignments.availableVehicles(dispatchId, provider.id, query);
  }
}
