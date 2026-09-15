import {
  BadRequestException,
  Controller,
  Get,
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
import { parsePublicId } from '../delivery-requests/delivery-requests.controller.js';
import {
  DeliveryQuotesService,
  integrationQuoteView,
} from './delivery-quotes.service.js';
import {
  DeliveryQuoteListQueryDto,
  QUOTE_PUBLIC_ID,
} from './delivery-quotes.dto.js';
import {
  DeliveryQuotePageResponse,
  DeliveryQuoteResponse,
} from './delivery-quotes.responses.js';

export function parseQuotePublicId(value: string) {
  const publicId = value.toUpperCase();
  if (!QUOTE_PUBLIC_ID.test(publicId))
    throw new BadRequestException(['publicId must match MQ-000000']);
  return publicId;
}
const requestParam = ApiParam({
  name: 'publicId',
  example: 'MDR-000001',
  description: 'DeliveryRequest propia.',
});
const quoteParam = ApiParam({
  name: 'publicId',
  example: 'MQ-000001',
  description: 'DeliveryQuote propia.',
});
const b2bErrors = {
  400: 'publicId o parámetros inválidos.',
  401: 'Token B2B inválido, expirado, revocado o de cliente suspendido; un JWT humano no es válido.',
  403: 'Falta el scope requerido.',
  404: 'No existe o pertenece a otro IntegrationClient (no se revela existencia).',
  429: 'Límite de peticiones excedido.',
  500: 'Error interno sanitizado.',
};

@ApiTags('Delivery Quotes (B2B)')
@ApiBearerAuth('integration-bearer')
@UseGuards(IntegrationGuard, IntegrationScopesGuard)
@Controller()
export class DeliveryQuotesController {
  constructor(private readonly quotes: DeliveryQuotesService) {}

  @Post('delivery-requests/:publicId/quotes')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @IntegrationScopes('quotes:create')
  @requestParam
  @ApiCreatedResponse({
    type: DeliveryQuoteResponse,
    description: 'Nueva Quote OFFERED (Quote-Reused: false).',
  })
  @ApiOkResponse({
    type: DeliveryQuoteResponse,
    description:
      'Quote vigente reutilizada (OFFERED no vencida o ACCEPTED), sin recalcular ni llamar a routing (Quote-Reused: true).',
  })
  @ApiErrorDescriptions({
    ...b2bErrors,
    409: 'DELIVERY_REQUEST_NOT_QUOTABLE: la solicitud no está CREATED.',
    422: 'OUT_OF_SERVICE_AREA | CROSS_ZONE_NOT_SUPPORTED | ROUTE_NOT_FOUND | DISTANCE_NOT_SUPPORTED. No se crea Quote; la solicitud sigue CREATED.',
    503: 'ROUTING_UNAVAILABLE | RATE_CONFIGURATION_UNAVAILABLE | RATE_CONFIGURATION_INVALID | SERVICE_ZONE_AMBIGUOUS. Reintentable; nunca se devuelve precio aproximado.',
  })
  @ApiOperation({
    summary: 'Cotizar mi DeliveryRequest',
    description:
      'Requiere quotes:create. Resuelve ServiceType (LOCAL_DELIVERY), zona ACTIVE de pickup y dropoff (misma zona), RatePlan ACTIVE, ruta real con el RoutingProvider y banda de distancia [min, max). Crea una Quote OFFERED inmutable con vigencia del plan. Si ya hay una OFFERED vigente o una ACCEPTED, la devuelve. Idempotente por DeliveryRequest (bloqueo de fila): peticiones simultáneas producen una sola Quote y una sola llamada de routing. 30/min por IP.',
  })
  async create(
    @Req() req: IntegrationRequest,
    @Param('publicId') publicId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { quote, reused } = await this.quotes.quote(
      parsePublicId(publicId),
      req.integration.id,
    );
    res.status(reused ? 200 : 201);
    res.setHeader('Quote-Reused', String(reused));
    return integrationQuoteView(quote);
  }

  @Get('delivery-requests/:publicId/quotes')
  @IntegrationScopes('quotes:read')
  @requestParam
  @ApiOkResponse({ type: DeliveryQuotePageResponse })
  @ApiErrorDescriptions(b2bErrors)
  @ApiOperation({
    summary: 'Historial de Quotes de mi DeliveryRequest',
    description:
      'Requiere quotes:read. Quotes de una solicitud propia, más recientes primero; snapshots persistidos sin recalcular.',
  })
  async listForRequest(
    @Req() req: IntegrationRequest,
    @Param('publicId') publicId: string,
    @Query() query: DeliveryQuoteListQueryDto,
  ) {
    const page = await this.quotes.listForRequest(
      parsePublicId(publicId),
      query,
      req.integration.id,
    );
    return { ...page, items: page.items.map((q) => integrationQuoteView(q)) };
  }

  @Get('delivery-quotes/:publicId')
  @IntegrationScopes('quotes:read')
  @quoteParam
  @ApiOkResponse({ type: DeliveryQuoteResponse })
  @ApiErrorDescriptions(b2bErrors)
  @ApiOperation({
    summary: 'Consultar mi Quote',
    description:
      'Requiere quotes:read. Devuelve el snapshot persistido (nunca recalcula amount). Quote ajena → 404.',
  })
  async get(
    @Req() req: IntegrationRequest,
    @Param('publicId') publicId: string,
  ) {
    return integrationQuoteView(
      await this.quotes.getOwned(
        parseQuotePublicId(publicId),
        req.integration.id,
      ),
    );
  }

  @Post('delivery-quotes/:publicId/accept')
  @HttpCode(200)
  @IntegrationScopes('quotes:accept')
  @quoteParam
  @ApiOkResponse({ type: DeliveryQuoteResponse })
  @ApiErrorDescriptions({
    ...b2bErrors,
    409: 'QUOTE_EXPIRED (expiresAt alcanzado; solicitar nueva Quote) | QUOTE_NOT_ACCEPTABLE (cancelada o solicitud cancelada).',
  })
  @ApiOperation({
    summary: 'Aceptar mi Quote',
    description:
      'Requiere quotes:accept. OFFERED vigente → ACCEPTED y congela el precio. Repetir sobre ACCEPTED es idempotente (200). Aceptaciones simultáneas producen una sola ACCEPTED. No asigna proveedor ni Driver (Dispatch V1.7).',
  })
  async accept(
    @Req() req: IntegrationRequest,
    @Param('publicId') publicId: string,
  ) {
    return integrationQuoteView(
      await this.quotes.accept(
        parseQuotePublicId(publicId),
        req.integration.id,
      ),
    );
  }
}
