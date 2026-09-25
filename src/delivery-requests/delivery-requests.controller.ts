import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { ApiErrorDescriptions } from '../common/api-errors.decorator.js';
import { IntegrationGuard } from '../integrations/integration.guard.js';
import type { IntegrationRequest } from '../integrations/integration.guard.js';
import {
  IntegrationScopes,
  IntegrationScopesGuard,
} from '../integrations/integration-scopes.js';
import { DeliveryRequestsService } from './delivery-requests.service.js';
import {
  CancelDeliveryRequestDto,
  CreateDeliveryRequestDto,
  DeliveryRequestListQueryDto,
  PUBLIC_ID,
} from './delivery-requests.dto.js';
import { toIntegrationView } from './delivery-request.select.js';
import {
  DeliveryRequestPageResponse,
  DeliveryRequestResponse,
} from './delivery-requests.responses.js';
import { DeliveryStatusResponse } from './delivery-status.responses.js';

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,255}$/;
export const publicIdParam = ApiParam({
  name: 'publicId',
  example: 'MDR-000123',
  description: 'Identificador operacional (MDR-NNNNNN).',
});
export function parsePublicId(value: string) {
  const publicId = value.toUpperCase();
  if (!PUBLIC_ID.test(publicId))
    throw new BadRequestException(['publicId must match MDR-000000']);
  return publicId;
}
const b2bErrors = {
  400: 'Validación fallida: campos, stops (1 PICKUP + 1 DROPOFF), packages, contexto financiero, filtros o Idempotency-Key. No se aceptan campos desconocidos ni integrationClientId.',
  401: 'Token B2B inválido, expirado, revocado o de un IntegrationClient/credencial suspendido. Un JWT humano no es válido aquí.',
  403: 'El token no incluye el scope requerido por la operación.',
  429: 'Límite de peticiones excedido.',
  500: 'Error interno sanitizado; no se exponen SQL, payloads ni datos personales.',
};

@ApiTags('Delivery Requests (B2B)')
@ApiBearerAuth('integration-bearer')
@UseGuards(IntegrationGuard, IntegrationScopesGuard)
@Controller('delivery-requests')
export class DeliveryRequestsController {
  constructor(private readonly requests: DeliveryRequestsService) {}

  @Post()
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @IntegrationScopes('deliveries:create')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      '8–255 caracteres ASCII visibles, único por IntegrationClient. Misma key + mismo payload → misma solicitud (200, Idempotent-Replayed: true). Misma key + payload distinto → 409.',
    example: '4f7c0d2e-8d1b-4f0e-9a51-3f7e2c1b9d10',
  })
  @ApiCreatedResponse({
    type: DeliveryRequestResponse,
    description: 'Solicitud creada (Idempotent-Replayed: false).',
  })
  @ApiOkResponse({
    type: DeliveryRequestResponse,
    description:
      'Repetición idempotente: devuelve la solicitud original sin crear otra.',
  })
  @ApiErrorDescriptions({
    ...b2bErrors,
    409: 'Idempotency-Key ya utilizada por este IntegrationClient con un payload diferente. La solicitud original no se modifica.',
  })
  @ApiOperation({
    summary: 'Crear DeliveryRequest (qué transportar)',
    description:
      'Requiere token B2B con deliveries:create e Idempotency-Key. El IntegrationClient se toma del token, nunca del body. Exactamente un PICKUP (sequence 1) y un DROPOFF (sequence 2) con coordenadas; al menos un package; contexto financiero PREPAID o COURIER_ADVANCE (este último exige goodsValue > 0). Crea todo de forma atómica en estado CREATED con publicId MDR-NNNNNN. No calcula costo ni asigna proveedor. 60 peticiones/minuto por IP.',
  })
  async create(
    @Req() req: IntegrationRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateDeliveryRequestDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey))
      throw new BadRequestException([
        'Idempotency-Key header is required (8-255 visible ASCII characters)',
      ]);
    const { result, replayed } = await this.requests.create(
      req.integration.id,
      idempotencyKey,
      dto,
    );
    res.status(replayed ? 200 : 201);
    res.setHeader('Idempotent-Replayed', String(replayed));
    return toIntegrationView(result);
  }

  @Get()
  @IntegrationScopes('deliveries:read')
  @ApiOkResponse({ type: DeliveryRequestPageResponse })
  @ApiErrorDescriptions(b2bErrors)
  @ApiOperation({
    summary: 'Listar mis DeliveryRequests',
    description:
      'Requiere deliveries:read. Siempre filtrado por el IntegrationClient del token. Filtros publicId, externalReference (exacto), status, requestedFrom/requestedTo; paginación page/pageSize y orden requestedAt DESC. Items resumidos sin datos de contacto.',
  })
  async list(
    @Req() req: IntegrationRequest,
    @Query() query: DeliveryRequestListQueryDto,
  ) {
    const page = await this.requests.list(query, req.integration.id);
    return { ...page, items: page.items.map(toIntegrationView) };
  }

  @Get(':publicId')
  @IntegrationScopes('deliveries:read')
  @publicIdParam
  @ApiOkResponse({ type: DeliveryRequestResponse })
  @ApiErrorDescriptions({
    ...b2bErrors,
    404: 'No existe o pertenece a otro IntegrationClient (no se revela existencia).',
  })
  @ApiOperation({
    summary: 'Consultar mi DeliveryRequest',
    description:
      'Requiere deliveries:read. Devuelve stops, packages y contexto financiero sólo si la solicitud pertenece al IntegrationClient del token; en caso contrario 404.',
  })
  async get(
    @Req() req: IntegrationRequest,
    @Param('publicId') publicId: string,
  ) {
    return toIntegrationView(
      await this.requests.findDetail(
        { publicId: parsePublicId(publicId) },
        req.integration.id,
      ),
    );
  }

  @Get(':publicId/status')
  @IntegrationScopes('deliveries:read')
  @publicIdParam
  @ApiOkResponse({ type: DeliveryStatusResponse })
  @ApiErrorDescriptions({
    ...b2bErrors,
    404: 'No existe o pertenece a otro IntegrationClient (no se revela existencia).',
  })
  @ApiOperation({
    summary: 'Consultar el estado logístico de mi DeliveryRequest',
    description:
      'Requiere deliveries:read. Sólo lectura: Mandaria sigue siendo la única autoridad logística y un IntegrationClient no marca entregas, ni reclama, ni asigna. Devuelve un estado público y estable —REQUESTED, OPEN, ASSIGNED, DELIVERED, CANCELLED o EXPIRED— que no expone el modelo interno de Dispatch: quién ejecuta se resume en execution.mode (PROVIDER o INDEPENDENT) y no se publican Driver, Vehicle, créditos ni políticas. deliveredAt llega con la entrega y es null antes. Apto para sondeo periódico: la lectura no tiene efectos.',
  })
  async status(
    @Req() req: IntegrationRequest,
    @Param('publicId') publicId: string,
  ) {
    return this.requests.deliveryStatus(
      parsePublicId(publicId),
      req.integration.id,
    );
  }

  @Post(':publicId/cancel')
  @HttpCode(200)
  @IntegrationScopes('deliveries:cancel')
  @publicIdParam
  @ApiOkResponse({ type: DeliveryRequestResponse })
  @ApiErrorDescriptions({
    ...b2bErrors,
    404: 'No existe o pertenece a otro IntegrationClient.',
  })
  @ApiOperation({
    summary: 'Cancelar mi DeliveryRequest',
    description:
      'Requiere deliveries:cancel. CREATED → CANCELLED con reason y cancelledAt. Si ya estaba CANCELLED responde 200 con el estado actual y conserva la razón y fecha originales. No existe edición ni borrado: para corregir datos, cancelar y crear otra solicitud.',
  })
  async cancel(
    @Req() req: IntegrationRequest,
    @Param('publicId') publicId: string,
    @Body() dto: CancelDeliveryRequestDto,
  ) {
    return toIntegrationView(
      await this.requests.cancel(parsePublicId(publicId), dto.reason, {
        type: 'INTEGRATION',
        integrationClientId: req.integration.id,
      }),
    );
  }
}
