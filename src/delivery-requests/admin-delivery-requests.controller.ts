import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AccessGuard, Roles, RolesGuard } from '../auth/auth.guards.js';
import type { AuthenticatedRequest } from '../auth/auth.guards.js';
import { ApiErrors } from '../common/api-errors.decorator.js';
import { DeliveryRequestsService } from './delivery-requests.service.js';
import {
  AdminDeliveryRequestListQueryDto,
  CancelDeliveryRequestDto,
} from './delivery-requests.dto.js';
import {
  AdminDeliveryRequestPageResponse,
  AdminDeliveryRequestResponse,
} from './delivery-requests.responses.js';
import {
  parsePublicId,
  publicIdParam,
} from './delivery-requests.controller.js';

@ApiTags('Admin Delivery Requests')
@ApiBearerAuth()
@ApiErrors(400, 401, 403, 404, 429, 500)
@UseGuards(AccessGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller('admin/delivery-requests')
export class AdminDeliveryRequestsController {
  constructor(private readonly requests: DeliveryRequestsService) {}
  @Get()
  @ApiOkResponse({ type: AdminDeliveryRequestPageResponse })
  @ApiOperation({
    summary: 'Listar todas las DeliveryRequests',
    description:
      'Sólo SUPER_ADMIN (lectura). Filtros publicId, integrationClientId, externalReference, status y requestedFrom/requestedTo; paginación page/pageSize, orden requestedAt DESC. Incluye el IntegrationClient en la misma consulta (sin N+1). PROVIDER_ADMIN y DRIVER reciben 403.',
  })
  list(@Query() query: AdminDeliveryRequestListQueryDto) {
    return this.requests.list(query);
  }
  @Get(':publicId')
  @publicIdParam
  @ApiOkResponse({ type: AdminDeliveryRequestResponse })
  @ApiOperation({
    summary: 'Consultar cualquier DeliveryRequest',
    description:
      'Sólo SUPER_ADMIN. Detalle completo con stops, packages, contexto financiero e IntegrationClient propietario. No existe creación, edición ni borrado administrativo.',
  })
  async get(@Param('publicId') publicId: string) {
    return this.requests.findDetail({ publicId: parsePublicId(publicId) });
  }
  @Post(':publicId/cancel')
  @HttpCode(200)
  @publicIdParam
  @ApiOkResponse({ type: AdminDeliveryRequestResponse })
  @ApiOperation({
    summary: 'Cancelar cualquier DeliveryRequest',
    description:
      'Sólo SUPER_ADMIN. CREATED → CANCELLED registrando al User como actor en DELIVERY_REQUEST_CANCELLED. Repetir sobre CANCELLED devuelve 200 sin cambiar razón ni fecha originales.',
  })
  cancel(
    @Param('publicId') publicId: string,
    @Body() dto: CancelDeliveryRequestDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.requests.cancel(parsePublicId(publicId), dto.reason, {
      type: 'USER',
      userId: req.user.id,
    });
  }
}
