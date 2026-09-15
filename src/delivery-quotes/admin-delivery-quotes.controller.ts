import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { AccessGuard, Roles, RolesGuard } from '../auth/auth.guards.js';
import { ApiErrors } from '../common/api-errors.decorator.js';
import { parsePublicId } from '../delivery-requests/delivery-requests.controller.js';
import { DeliveryQuotesService, quoteView } from './delivery-quotes.service.js';
import {
  AdminDeliveryQuoteListQueryDto,
  DeliveryQuoteListQueryDto,
} from './delivery-quotes.dto.js';
import { parseQuotePublicId } from './delivery-quotes.controller.js';
import {
  AdminDeliveryQuotePageResponse,
  AdminDeliveryQuoteResponse,
} from './delivery-quotes.responses.js';

@ApiTags('Admin Delivery Quotes')
@ApiBearerAuth()
@ApiErrors(400, 401, 403, 404, 429, 500)
@UseGuards(AccessGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller()
export class AdminDeliveryQuotesController {
  constructor(private readonly quotes: DeliveryQuotesService) {}
  @Get('admin/delivery-quotes')
  @ApiOkResponse({ type: AdminDeliveryQuotePageResponse })
  @ApiOperation({
    summary: 'Listar Quotes',
    description:
      'Sólo SUPER_ADMIN (lectura). Filtros publicId, deliveryRequestPublicId, integrationClientId, serviceZoneId, status efectivo y createdFrom/createdTo; paginación. Incluye plan, versión y banda aplicados. No existe edición, eliminación ni aceptación administrativa.',
  })
  async list(@Query() query: AdminDeliveryQuoteListQueryDto) {
    const page = await this.quotes.list(query);
    return { ...page, items: page.items.map((q) => quoteView(q)) };
  }
  @Get('admin/delivery-quotes/:publicId')
  @ApiParam({ name: 'publicId', example: 'MQ-000001' })
  @ApiOkResponse({ type: AdminDeliveryQuoteResponse })
  @ApiOperation({
    summary: 'Consultar cualquier Quote',
    description:
      'Sólo SUPER_ADMIN. Snapshot completo con RatePlan/RateBand aplicados, proveedor de routing y timestamps de estado.',
  })
  async get(@Param('publicId') publicId: string) {
    return quoteView(await this.quotes.get(parseQuotePublicId(publicId)));
  }
  @Get('admin/delivery-requests/:publicId/quotes')
  @ApiParam({ name: 'publicId', example: 'MDR-000001' })
  @ApiOkResponse({ type: AdminDeliveryQuotePageResponse })
  @ApiOperation({
    summary: 'Quotes de una DeliveryRequest',
    description:
      'Sólo SUPER_ADMIN. Historial de Quotes (OFFERED, ACCEPTED, EXPIRED, CANCELLED) de cualquier solicitud.',
  })
  async listForRequest(
    @Param('publicId') publicId: string,
    @Query() query: DeliveryQuoteListQueryDto,
  ) {
    const page = await this.quotes.listForRequest(
      parsePublicId(publicId),
      query,
    );
    return { ...page, items: page.items.map((q) => quoteView(q)) };
  }
}
