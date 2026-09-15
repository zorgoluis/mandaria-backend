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
import { RatePlansService } from './rate-plans.service.js';
import {
  CreateRatePlanDto,
  RatePlanListQueryDto,
  ReplaceRateBandsDto,
  UpdateRatePlanDto,
} from './rate-plans.dto.js';
import {
  RatePlanPageResponse,
  RatePlanResponse,
  RatePlanValidationResponse,
} from './rate-plans.responses.js';

const idParam = ApiParam({
  name: 'id',
  format: 'uuid',
  description: 'RatePlan.id',
});

@ApiTags('Admin Rate Plans')
@ApiBearerAuth()
@ApiErrors(400, 401, 403, 404, 409, 429, 500)
@UseGuards(AccessGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller('admin/rate-plans')
export class AdminRatePlansController {
  constructor(private readonly plans: RatePlansService) {}
  @Post()
  @ApiCreatedResponse({ type: RatePlanResponse })
  @ApiOperation({
    summary: 'Crear RatePlan DRAFT',
    description:
      'Sólo SUPER_ADMIN. Crea la siguiente versión DRAFT para ServiceZone + ServiceType con calculationType DISTANCE_BANDS, quoteValidityMinutes (LOCAL_DELIVERY 1–120, recomendado 15) y bandas opcionales. La moneda se hereda de la zona.',
  })
  create(@Body() dto: CreateRatePlanDto, @Req() req: AuthenticatedRequest) {
    return this.plans.create(dto, req.user.id);
  }
  @Get()
  @ApiOkResponse({ type: RatePlanPageResponse })
  @ApiOperation({
    summary: 'Listar versiones de RatePlans',
    description:
      'Sólo SUPER_ADMIN. Filtros serviceZoneId, serviceType y status; orden por versión descendente. Incluye históricos INACTIVE con sus bandas.',
  })
  list(@Query() query: RatePlanListQueryDto) {
    return this.plans.list(query);
  }
  @Get(':id')
  @idParam
  @ApiOkResponse({ type: RatePlanResponse })
  @ApiOperation({
    summary: 'Consultar versión',
    description:
      'Sólo SUPER_ADMIN. Plan con bandas ordenadas por distancia; incluye históricos.',
  })
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.plans.get(id);
  }
  @Patch(':id')
  @idParam
  @ApiOkResponse({ type: RatePlanResponse })
  @ApiOperation({
    summary: 'Editar DRAFT',
    description:
      'Sólo SUPER_ADMIN. Cambia quoteValidityMinutes de un DRAFT; ACTIVE/INACTIVE responden 409 RATE_PLAN_NOT_EDITABLE.',
  })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateRatePlanDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.plans.update(id, dto.quoteValidityMinutes, req.user.id);
  }
  @Put(':id/bands')
  @idParam
  @ApiOkResponse({ type: RatePlanResponse })
  @ApiOperation({
    summary: 'Reemplazar bandas del DRAFT',
    description:
      'Sólo SUPER_ADMIN. Sustituye todas las bandas de forma atómica. Semántica [min, max): min inclusivo, max exclusivo, en metros. Se permiten borradores incompletos; la activación exige cobertura contigua desde 0.',
  })
  bands(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReplaceRateBandsDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.plans.replaceBands(id, dto.bands, req.user.id);
  }
  @Post(':id/clone')
  @idParam
  @ApiCreatedResponse({ type: RatePlanResponse })
  @ApiOperation({
    summary: 'Clonar versión a nuevo DRAFT',
    description:
      'Sólo SUPER_ADMIN. Copia TTL y bandas (normalmente del ACTIVE) en la siguiente versión DRAFT, sin modificar el original.',
  })
  clone(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.plans.clone(id, req.user.id);
  }
  @Post(':id/validate')
  @HttpCode(200)
  @idParam
  @ApiOkResponse({ type: RatePlanValidationResponse })
  @ApiOperation({
    summary: 'Validar bandas',
    description:
      'Sólo SUPER_ADMIN. Informa huecos, solapes, límites inválidos, montos <= 0 y monedas inconsistentes sin cambiar el plan.',
  })
  validate(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.plans.validate(id);
  }
  @Post(':id/activate')
  @HttpCode(200)
  @idParam
  @ApiOkResponse({ type: RatePlanResponse })
  @ApiOperation({
    summary: 'Activar DRAFT',
    description:
      'Sólo SUPER_ADMIN. DRAFT válido → ACTIVE y la versión ACTIVE anterior → INACTIVE en la misma transacción (índice único parcial: máximo un ACTIVE por zona + servicio). Bandas inválidas → 422 RATE_PLAN_INVALID; INACTIVE → 409 RATE_PLAN_NOT_ACTIVATABLE; repetir sobre ACTIVE es idempotente.',
  })
  activate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.plans.activate(id, req.user.id);
  }
  @Post(':id/deactivate')
  @HttpCode(200)
  @idParam
  @ApiOkResponse({ type: RatePlanResponse })
  @ApiOperation({
    summary: 'Desactivar versión ACTIVE',
    description:
      'Sólo SUPER_ADMIN. ACTIVE → INACTIVE sin reemplazo; nuevas cotizaciones fallan con RATE_CONFIGURATION_UNAVAILABLE. Las Quotes existentes conservan su snapshot.',
  })
  deactivate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.plans.deactivate(id, req.user.id);
  }
}
