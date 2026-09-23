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
import { AccessGuard, Roles, RolesGuard } from '../auth/auth.guards.js';
import type { AuthenticatedRequest } from '../auth/auth.guards.js';
import { ApiErrorDescriptions } from '../common/api-errors.decorator.js';
import { PaginationQueryDto } from '../common/pagination.dto.js';
import { IndependentDispatchesService } from './independent-dispatches.service.js';
import {
  CompleteServiceDto,
  ReleaseDispatchDto,
  TakeDispatchDto,
} from './independent-drivers.dto.js';
import {
  DriverDispatchPageResponse,
  DriverDispatchResponse,
  IndependentVehicleResponse,
} from './independent-drivers.responses.js';

const dispatchParam = ApiParam({
  name: 'dispatchId',
  format: 'uuid',
  description:
    'Dispatch.id. Un Dispatch que no puedo tomar ni tengo tomado responde 404 igual que un id inexistente: los ids no se pueden sondear.',
});
const base = {
  400: 'VALIDATION_ERROR: UUID, motivo o campos inválidos; campos desconocidos rechazados.',
  401: 'Se requiere access JWT humano de un User ACTIVE; un token B2B no es válido.',
  403: 'Rol global distinto de DRIVER. SUPER_ADMIN y PROVIDER_ADMIN no pueden tomar ni liberar servicios haciéndose pasar por el repartidor.',
  404: 'Sin perfil Driver, o Dispatch/vehículo inexistente o ajeno.',
  429: 'Límite de peticiones por IP excedido (100/minuto).',
  500: 'Error interno sanitizado.',
};
const notApproved =
  'INDEPENDENT_NOT_APPROVED: el Driver no está habilitado como independiente, o su perfil está SUSPENDED, REJECTED o PENDING.';

@ApiTags('Driver Independent Dispatches')
@ApiBearerAuth()
@UseGuards(AccessGuard, RolesGuard)
@Roles('DRIVER')
@Controller('driver')
export class DriverDispatchesController {
  constructor(private readonly dispatches: IndependentDispatchesService) {}

  @Get('vehicles')
  @ApiOkResponse({ type: IndependentVehicleResponse, isArray: true })
  @ApiErrorDescriptions({ ...base, 409: notApproved })
  @ApiOperation({
    summary: 'Mis vehículos como repartidor independiente',
    description:
      'Vehículos propios, para elegir vehicleId al tomar un servicio. Nunca incluye vehículos del proveedor del que el repartidor forma parte en V1.4: ese contexto se administra por las rutas de proveedor y no otorga recursos propios.',
  })
  vehicles(@Req() req: AuthenticatedRequest) {
    return this.dispatches.myVehicles(req.user.id);
  }

  @Get('dispatches/available')
  @ApiOkResponse({ type: DriverDispatchPageResponse })
  @ApiErrorDescriptions({ ...base, 409: notApproved })
  @ApiOperation({
    summary: 'Servicios que puedo tomar',
    description:
      'Dispatches OPEN dentro de su ventana cuyo ServiceType admite repartidores independientes según la política de ejecución (V1.9: LOCAL_DELIVERY admite flotilla e independiente). Excluye los que este repartidor ya liberó. Devuelve sólo lo necesario para decidir: ruta, direcciones con coordenadas, paquetes sin texto libre y el contexto de pago, incluido cuánto habría que adelantar por la mercancía. No expone contactos, instrucciones, proveedores, candidaturas, el IntegrationClient ni datos administrativos. Paginado, con la ventana más próxima a cerrarse primero. Que un servicio aparezca no garantiza poder tomarlo: la disponibilidad del repartidor y del vehículo se resuelve bajo bloqueos en el momento de tomarlo.',
  })
  available(
    @Query() query: PaginationQueryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.dispatches.available(req.user.id, query);
  }

  @Get('dispatches/:dispatchId')
  @dispatchParam
  @ApiOkResponse({ type: DriverDispatchResponse })
  @ApiErrorDescriptions({ ...base, 409: notApproved })
  @ApiOperation({
    summary: 'Detalle de un servicio ofrecido o tomado por mí',
    description:
      'Con access OFFER muestra lo mismo que el listado; con access OWNER (lo tomé yo) agrega contactos, instrucciones, descripciones de paquete y la referencia pública del pedido. Un servicio tomado por un proveedor o por otro repartidor responde 404.',
  })
  get(
    @Param('dispatchId', new ParseUUIDPipe()) dispatchId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.dispatches.get(req.user.id, dispatchId);
  }

  @Post('dispatches/:dispatchId/take')
  @HttpCode(200)
  @dispatchParam
  @ApiOkResponse({ type: DriverDispatchResponse })
  @ApiErrorDescriptions({
    ...base,
    409: `${notApproved} | DISPATCH_ALREADY_CLAIMED (lo tomó un proveedor u otro repartidor) | DISPATCH_EXPIRED | DISPATCH_CANCELLED | DISPATCH_NOT_OPEN_TO_INDEPENDENT (ese ServiceType no admite independientes) | DISPATCH_RETAKE_NOT_ALLOWED (yo lo liberé) | DRIVER_NOT_ELIGIBLE | VEHICLE_NOT_ELIGIBLE | DRIVER_BUSY | VEHICLE_BUSY (ya tengo, o el vehículo tiene, una asignación ACTIVE en cualquiera de los dos modelos) | TAKE_CONFLICT | INSUFFICIENT_CREDITS (mi saldo no cubre el creditCost del servicio; no se toma nada) | CREDIT_ACCOUNT_UNAVAILABLE | CREDIT_SNAPSHOT_UNAVAILABLE (servicio monetizado sin costo congelado) | CREDIT_MOVEMENT_CONFLICT.`,
  })
  @ApiOperation({
    summary: 'Tomar un servicio',
    description:
      'Operación atómica: en una sola transacción el Dispatch pasa a CLAIMED a nombre de este repartidor y se crea su DeliveryAssignment ACTIVE en modo INDEPENDENT. Nunca queda un claim sin asignación ni una asignación sin claim. El repartidor se resuelve desde el JWT y la pertenencia del vehículo se relee en la base de datos, así que un vehicleId de un proveedor o de otro repartidor responde 404. Bloquea la misma fila de Dispatch que el claim de proveedor: si un proveedor reclama y un independiente toma a la vez, gana exactamente uno y el otro recibe 409. Máximo una asignación ACTIVE por Dispatch, por Driver y por Vehicle, contando flotilla e independiente: un repartidor ocupado en un servicio de proveedor no puede tomar uno propio, y al revés. Devuelve el servicio con access OWNER y su paymentContext. Mandaria no verifica si el repartidor dispone del efectivo para adelantar la mercancía. V1.10-D: tomar un servicio monetizado cobra en la misma transacción el creditCost congelado a la cuenta de créditos del repartidor (un SERVICE_AWARD por servicio); sin saldo suficiente no hay claim, ni asignación, ni cargo. Liberar no devuelve créditos todavía.',
  })
  take(
    @Param('dispatchId', new ParseUUIDPipe()) dispatchId: string,
    @Body() dto: TakeDispatchDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.dispatches.take(req.user.id, dispatchId, dto.vehicleId);
  }

  @Post('dispatches/:dispatchId/release')
  @HttpCode(200)
  @dispatchParam
  @ApiOkResponse({ type: DriverDispatchResponse })
  @ApiErrorDescriptions({
    ...base,
    409: `${notApproved} | DISPATCH_NOT_CLAIMED_BY_DRIVER: el Dispatch no está tomado por este repartidor. | CREDIT_REFUND_INTEGRITY_ERROR: el servicio se cobró y su cargo no aparece.`,
  })
  @ApiOperation({
    summary: 'Liberar un servicio que tomé',
    description:
      'Operación atómica con motivo obligatorio: la asignación ACTIVE pasa a CANCELLED con el motivo, se limpia el claim independiente y el Dispatch vuelve a OPEN para quien pueda tomarlo (un proveedor candidato u otro repartidor); si la ventana ya cerró queda EXPIRED, igual que la liberación de proveedor de V1.7. El repartidor y el vehículo quedan libres. No existe reasignación para el rol DRIVER: un repartidor no puede pasarle el servicio a otro ni asignarse uno ajeno; liberar es la única salida. Quien libera no puede volver a tomar ese mismo Dispatch. V1.10-E: si el servicio se había cobrado, liberarlo devuelve en la misma transacción el 100% de esos créditos a la cuenta del repartidor, con un SERVICE_REFUND que compensa al SERVICE_AWARD original.',
  })
  release(
    @Param('dispatchId', new ParseUUIDPipe()) dispatchId: string,
    @Body() dto: ReleaseDispatchDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.dispatches.release(req.user.id, dispatchId, dto);
  }

  @Post('dispatches/:dispatchId/deliver')
  @HttpCode(200)
  @dispatchParam
  @ApiOkResponse({ type: DriverDispatchResponse })
  @ApiErrorDescriptions({
    ...base,
    409: 'DISPATCH_NOT_CLAIMED_BY_DRIVER: el servicio no está tomado por este repartidor (nunca lo tomó, lo liberó, o lo tiene otro) | NO_ACTIVE_ASSIGNMENT: el servicio no tiene asignación ACTIVE que cerrar | DELIVERY_CONFLICT: el Dispatch o su asignación cambiaron durante la confirmación; reintentar.',
  })
  @ApiOperation({
    summary: 'Confirmar la entrega de un servicio que tomé',
    description:
      'Sin body (cualquier campo se rechaza con 400): el repartidor sale del JWT y la fecha la pone el servidor. Cierre operativo mínimo del flujo independiente TAKE -> DELIVERED: en una sola transacción mi asignación ACTIVE queda COMPLETED (sin motivo de fin: nada falló) y el Dispatch pasa a DELIVERED con deliveredAt y deliveredByUserId. DELIVERED es terminal e irreversible: el servicio ya no se puede liberar ni volver a tomar, y una cancelación posterior de la DeliveryRequest no lo toca. Yo y mi vehículo quedamos libres de inmediato para otro servicio, conservando el historial. Sólo el repartidor que tomó el servicio: SUPER_ADMIN, PROVIDER_ADMIN, otro repartidor y los clientes B2B no pueden confirmar entregas. Cuesta 0 créditos y no genera SERVICE_REFUND: el cargo hecho al tomarlo es lo que el servicio entregado paga. No recalcula precio, ruta, política ni costo en créditos. A diferencia de tomar un servicio, confirmar la entrega no vuelve a exigir el perfil APPROVED: el trabajo ya se hizo y una suspensión posterior no puede dejar el servicio sin cerrar. Repetir la confirmación devuelve 200 sin cambios.',
  })
  deliver(
    @Param('dispatchId', new ParseUUIDPipe()) dispatchId: string,
    @Body() _body: CompleteServiceDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.dispatches.complete(req.user.id, dispatchId);
  }
}
