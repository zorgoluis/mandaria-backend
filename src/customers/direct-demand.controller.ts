import { PaginationQueryDto, pageResult } from '../common/pagination.dto.js';
import {
  DeliveryRequestResponse,
  DeliveryRequestPageResponse,
} from '../delivery-requests/delivery-requests.responses.js';
import { DeliveryStatusResponse } from '../delivery-requests/delivery-status.responses.js';
import {
  Query,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiTags,
  ApiResponse,
} from '@nestjs/swagger';
import { AccessGuard, type AuthenticatedRequest } from '../auth/auth.guards.js';
import { CustomersService } from './customers.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PrequotesService } from '../delivery-prequotes/prequotes.service.js';
import { PrequoteConversionService } from '../delivery-prequotes/prequote-conversion.service.js';
import { AuthorizedAcceptanceService } from '../delivery-quotes/authorized-acceptance.service.js';
import { DeliveryRequestsService } from '../delivery-requests/delivery-requests.service.js';
import { CancelDeliveryRequestDto } from '../delivery-requests/delivery-requests.dto.js';
import {
  deliveryRequestDetailSelect,
  toDetail,
  toIntegrationView,
} from '../delivery-requests/delivery-request.select.js';
import { integrationQuoteView } from '../delivery-quotes/delivery-quotes.service.js';
import { publicDeliveryStatus } from '../delivery-requests/public-delivery-tracking.js';
import {
  DirectPrequoteDto,
  DirectPrequoteResponse,
  DirectPrequoteCreatedResponse,
  DirectConversionResponse,
  DirectAcceptedResponse,
  DirectConversionDto,
  DirectAcceptanceDto,
} from './direct-demand.dto.js';

@ApiTags('Customer deliveries')
@ApiBearerAuth()
@UseGuards(AccessGuard)
@ApiResponse({
  status: 403,
  description: 'CUSTOMER_ACCESS_DENIED o CUSTOMER_CONTACT_NOT_VERIFIED.',
})
@ApiResponse({
  status: 404,
  description: 'Recurso inexistente o de otro titular.',
})
@ApiResponse({
  status: 409,
  description:
    'Conflicto de cupo, términos, idempotencia, vencimiento o custodia. Consultar recurso propio antes de reintentar.',
})
@Controller('customer')
export class DirectDemandController {
  constructor(
    private readonly customers: CustomersService,
    private readonly db: PrismaService,
    private readonly prequotes: PrequotesService,
    private readonly conversions: PrequoteConversionService,
    private readonly acceptance: AuthorizedAcceptanceService,
    private readonly requests: DeliveryRequestsService,
  ) {}
  private async owner(req: AuthenticatedRequest) {
    return {
      kind: 'CUSTOMER' as const,
      id: (await this.customers.account(req.user.id)).id,
    };
  }
  @Post('delivery-prequotes')
  @ApiOperation({
    summary:
      'Precotizar solicitud directa con tarifas compartidas; no reserva cupo',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ type: DirectPrequoteDto })
  @ApiResponse({ status: 201, type: DirectPrequoteCreatedResponse })
  async prequote(
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException();
    const input = body as Record<string, unknown>;
    if (
      Object.keys(input).some(
        (k) => !['conditions', 'shippingPayer'].includes(k),
      ) ||
      (input.shippingPayer !== undefined &&
        input.shippingPayer !== 'REQUESTER' &&
        input.shippingPayer !== 'RECIPIENT')
    )
      throw new BadRequestException();
    return this.prequotes.create(
      await this.owner(req),
      req.user.id,
      key,
      input.conditions,
      input.shippingPayer,
    );
  }
  @Get('delivery-prequotes/:publicId')
  @ApiOperation({
    summary:
      'Consultar precotización propia y recuperar conversión por clave/referencia original',
  })
  @ApiResponse({ status: 200, type: DirectPrequoteResponse })
  async prequoteGet(
    @Req() req: AuthenticatedRequest,
    @Param('publicId') id: string,
  ) {
    return this.prequotes.get(id, await this.owner(req));
  }
  @Post('delivery-prequotes/:publicId/convert')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({
    summary: 'Convertir una vez; PERSONAL ocupa un cupo hasta cierre durable',
  })
  @ApiResponse({ status: 201, type: DirectConversionResponse })
  async convert(
    @Req() req: AuthenticatedRequest,
    @Param('publicId') id: string,
    @Headers('idempotency-key') key: string,
    @Body() dto: DirectConversionDto,
  ) {
    return this.conversions.convert(await this.owner(req), id, key, dto);
  }
  @Post('delivery-quotes/:publicId/accept')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({
    summary:
      'Consentir MQ y términos exactos; no confirma cobro ni entrega física',
  })
  @ApiResponse({ status: 200, type: DirectAcceptedResponse })
  async accept(
    @Req() req: AuthenticatedRequest,
    @Param('publicId') id: string,
    @Headers('idempotency-key') key: string,
    @Body() dto: DirectAcceptanceDto,
  ) {
    const owner = await this.owner(req);
    const result = await this.acceptance.acceptDirect(
      id,
      owner.id,
      req.user.id,
      req.authentication,
      key,
      dto,
    );
    return {
      quote: integrationQuoteView(result.result),
      replayed: result.replayed,
    };
  }
  @Get('delivery-requests')
  @ApiOperation({
    summary: 'Solicitudes propias paginadas; titular aislado del canal B2B',
  })
  @ApiResponse({ status: 200, type: DeliveryRequestPageResponse })
  async list(
    @Req() req: AuthenticatedRequest,
    @Query() query: PaginationQueryDto,
  ) {
    const owner = await this.owner(req);
    return this.db.$transaction(
      async (tx) => {
        const where = {
          customerAccountId: owner.id,
          integrationClientId: null,
        };
        const items = await tx.deliveryRequest.findMany({
          where,
          select: deliveryRequestDetailSelect,
          orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
          take: query.pageSize,
          skip: (query.page - 1) * query.pageSize,
        });
        return pageResult(
          items.map((row) => toIntegrationView(toDetail(row))),
          await tx.deliveryRequest.count({ where }),
          query,
        );
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  @Get('delivery-requests/:publicId')
  @ApiOperation({ summary: 'Detalle propio e instrucciones persistidas' })
  @ApiResponse({ status: 200, type: DeliveryRequestResponse })
  async detail(
    @Req() req: AuthenticatedRequest,
    @Param('publicId') id: string,
  ) {
    const owner = await this.owner(req);
    const row = await this.db.deliveryRequest.findFirst({
      where: {
        publicId: id,
        customerAccountId: owner.id,
        integrationClientId: null,
      },
      select: deliveryRequestDetailSelect,
    });
    if (!row) throw new NotFoundException();
    return toIntegrationView(toDetail(row));
  }
  @Get('delivery-requests/:publicId/status')
  @ApiOperation({
    summary:
      'Fotografía logística propia; ordenar por publicVersion por solicitud',
  })
  @ApiResponse({ status: 200, type: DeliveryStatusResponse })
  async status(
    @Req() req: AuthenticatedRequest,
    @Param('publicId') id: string,
  ) {
    return publicDeliveryStatus(this.db, id, await this.owner(req));
  }
  @Post('delivery-requests/:publicId/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Cancelar solicitud propia; repetición segura, custodia bloquea cancelación ordinaria',
  })
  @ApiResponse({ status: 200, type: DeliveryStatusResponse })
  async cancel(
    @Req() req: AuthenticatedRequest,
    @Param('publicId') id: string,
    @Body() dto: CancelDeliveryRequestDto,
  ) {
    const owner = await this.owner(req);
    await this.requests.cancel(id, dto.reason, {
      type: 'CUSTOMER',
      customerAccountId: owner.id,
      userId: req.user.id,
    });
    return this.status(req, id);
  }
}
