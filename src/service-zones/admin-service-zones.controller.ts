import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
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
import { ServiceZonesService } from './service-zones.service.js';
import {
  CreateServiceZoneDto,
  ReplaceBoundaryDto,
  ServiceZoneListQueryDto,
  UpdateServiceZoneDto,
} from './service-zones.dto.js';
import {
  ServiceZonePageResponse,
  ServiceZoneResponse,
} from './service-zones.responses.js';

const idParam = ApiParam({
  name: 'id',
  format: 'uuid',
  description: 'ServiceZone.id',
});

@ApiTags('Admin Service Zones')
@ApiBearerAuth()
@ApiErrors(400, 401, 403, 404, 409, 429, 500)
@UseGuards(AccessGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller('admin/service-zones')
export class AdminServiceZonesController {
  constructor(private readonly zones: ServiceZonesService) {}
  @Post()
  @ApiCreatedResponse({ type: ServiceZoneResponse })
  @ApiOperation({
    summary: 'Crear zona de servicio',
    description:
      'Sólo SUPER_ADMIN. Nace INACTIVE con código único, moneda ISO 4217 inmutable y boundary GeoJSON validado (Polygon/MultiPolygon). No contiene reglas específicas de ninguna ciudad; cada zona es configuración.',
  })
  create(@Body() dto: CreateServiceZoneDto, @Req() req: AuthenticatedRequest) {
    return this.zones.create(dto, req.user.id);
  }
  @Get()
  @ApiOkResponse({ type: ServiceZonePageResponse })
  @ApiOperation({
    summary: 'Listar zonas de servicio',
    description:
      'Sólo SUPER_ADMIN. Filtros status y search (código/nombre); paginación page/pageSize, orden por código. Los items no incluyen boundary; usar el detalle.',
  })
  list(@Query() query: ServiceZoneListQueryDto) {
    return this.zones.list(query);
  }
  @Get(':id')
  @idParam
  @ApiOkResponse({ type: ServiceZoneResponse })
  @ApiOperation({
    summary: 'Consultar zona con boundary',
    description:
      'Sólo SUPER_ADMIN. Devuelve boundary GeoJSON normalizado y bounding box calculado.',
  })
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.zones.get(id);
  }
  @Patch(':id')
  @idParam
  @ApiOkResponse({ type: ServiceZoneResponse })
  @ApiOperation({
    summary: 'Renombrar zona',
    description:
      'Sólo SUPER_ADMIN. Sólo cambia name; código y moneda son inmutables y el boundary tiene su propia operación.',
  })
  rename(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateServiceZoneDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.zones.rename(id, dto.name, req.user.id);
  }
  @Put(':id/boundary')
  @idParam
  @ApiOkResponse({ type: ServiceZoneResponse })
  @ApiOperation({
    summary: 'Reemplazar boundary (zona INACTIVE)',
    description:
      'Sólo SUPER_ADMIN. Sustituye el GeoJSON completo y recalcula el bounding box. Con la zona ACTIVE responde 409 SERVICE_ZONE_NOT_EDITABLE: desactivar, reemplazar y volver a activar. No es un editor cartográfico.',
  })
  boundary(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReplaceBoundaryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.zones.replaceBoundary(id, dto.boundary, req.user.id);
  }
  @Post(':id/activate')
  @HttpCode(200)
  @idParam
  @ApiOkResponse({ type: ServiceZoneResponse })
  @ApiOperation({
    summary: 'Activar zona',
    description:
      'Sólo SUPER_ADMIN. INACTIVE → ACTIVE (idempotente). Rechaza con 409 SERVICE_ZONE_OVERLAP si el boundary interseca o toca otra zona ACTIVE, de modo que cada punto pertenece como máximo a una zona. Activaciones serializadas con advisory lock.',
  })
  activate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.zones.activate(id, req.user.id);
  }
  @Post(':id/deactivate')
  @HttpCode(200)
  @idParam
  @ApiOkResponse({ type: ServiceZoneResponse })
  @ApiOperation({
    summary: 'Desactivar zona',
    description:
      'Sólo SUPER_ADMIN. ACTIVE → INACTIVE (idempotente). Las nuevas cotizaciones dentro de la zona fallan con OUT_OF_SERVICE_AREA; las Quotes existentes conservan su snapshot.',
  })
  deactivate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.zones.deactivate(id, req.user.id);
  }
}
