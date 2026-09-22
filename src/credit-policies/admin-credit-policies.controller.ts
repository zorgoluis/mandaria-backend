import {
  Body,
  Controller,
  Get,
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
import { CreditPoliciesService } from './credit-policies.service.js';
import {
  CreateCreditPolicyDto,
  CreateCreditPolicyVersionDto,
  CreditCostQueryDto,
  CreditPolicyListQueryDto,
} from './credit-policies.dto.js';
import {
  CreditCostResponse,
  CreditPolicyPageResponse,
  CreditPolicyResponse,
} from './credit-policies.responses.js';

const errors = {
  400: 'VALIDATION_ERROR: UUID, enum o filtros inválidos; campos de otro calculationType (p. ej. flatCredits en PER_KM); rangos con huecos, solapes, sin empezar en 0 o sin último rango abierto; créditos no enteros o fuera de 0..1 000 000; campos desconocidos (version, status, createdByUserId, effectiveFrom...).',
  401: 'Se requiere access JWT humano de un User ACTIVE; un token B2B no es válido.',
  403: 'Sólo SUPER_ADMIN. PROVIDER_ADMIN y DRIVER no leen ni administran políticas: en versiones posteriores recibirán sólo el creditCost del servicio.',
  404: 'Política inexistente.',
  429: 'Límite de peticiones por IP excedido (100/minuto).',
  500: 'Error interno sanitizado.',
};
const notCharging =
  ' V1.10-B sólo define y calcula: CLAIM y TAKE todavía NO consumen créditos.';

@ApiTags('Admin Credit Policies')
@ApiBearerAuth()
@UseGuards(AccessGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller('admin/credit-policies')
export class AdminCreditPoliciesController {
  constructor(private readonly policies: CreditPoliciesService) {}

  @Get()
  @ApiOkResponse({ type: CreditPolicyPageResponse })
  @ApiErrorDescriptions(errors)
  @ApiOperation({
    summary: 'Listar políticas de créditos (historial)',
    description:
      'Todas las versiones, ACTIVE e INACTIVE, ordenadas por serviceType, actorType y versión descendente. Filtros serviceType, actorType y status; paginado (máximo 100).' +
      notCharging,
  })
  list(@Query() query: CreditPolicyListQueryDto) {
    return this.policies.list(query);
  }

  @Get('calculation')
  @ApiOkResponse({ type: CreditCostResponse })
  @ApiErrorDescriptions({
    ...errors,
    404: 'No aplica.',
    409: 'CREDIT_POLICY_UNAVAILABLE: no hay política ACTIVE para serviceType + actorType. Nunca se asume 0 créditos.',
    422: 'CREDIT_COST_OUT_OF_RANGE: el costo superaría 1 000 000 créditos por servicio.',
  })
  @ApiOperation({
    summary: 'Calcular el costo en créditos de un servicio',
    description:
      'Resuelve la política ACTIVE de serviceType + actorType y calcula el costo para una distancia canónica en metros enteros, sin llamar a ningún proveedor de routing. Sólo lectura: no toca cuentas ni ledger.' +
      notCharging,
  })
  calculate(@Query() query: CreditCostQueryDto) {
    return this.policies.calculate(
      query.serviceType,
      query.actorType,
      query.distanceMeters,
    );
  }

  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CreditPolicyResponse })
  @ApiErrorDescriptions(errors)
  @ApiOperation({
    summary: 'Consultar una versión de política de créditos',
    description:
      'Configuración completa, incluidos los rangos, autor y vigencia (effectiveFrom/effectiveUntil).',
  })
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.policies.get(id);
  }

  @Post()
  @ApiCreatedResponse({ type: CreditPolicyResponse })
  @ApiErrorDescriptions({
    ...errors,
    409: 'CREDIT_POLICY_EXISTS: la combinación ya tiene políticas; crear una nueva versión desde la ACTIVE. CREDIT_POLICY_VERSION_CONFLICT: carrera perdida con otra creación simultánea.',
  })
  @ApiOperation({
    summary: 'Crear la primera política de una combinación',
    description:
      'Crea la versión 1, ACTIVE desde ahora, para un serviceType + actorType que nunca tuvo política. version, status, vigencia y autor los decide el servidor.' +
      notCharging,
  })
  create(@Body() dto: CreateCreditPolicyDto, @Req() req: AuthenticatedRequest) {
    return this.policies.createInitial(dto, { userId: req.user.id });
  }

  @Post(':id/versions')
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description:
      'La versión ACTIVE actual de la combinación, que será reemplazada.',
  })
  @ApiCreatedResponse({ type: CreditPolicyResponse })
  @ApiErrorDescriptions({
    ...errors,
    409: 'CREDIT_POLICY_VERSION_CONFLICT: la política indicada ya no es la ACTIVE (otra versión la reemplazó, p. ej. en una solicitud simultánea). No se escribe nada; recargar y reintentar sobre la ACTIVE.',
  })
  @ApiOperation({
    summary: 'Crear una nueva versión de una política de créditos',
    description:
      'Nunca edita la versión existente: en una sola transacción la ACTIVE pasa a INACTIVE (effectiveUntil = ahora) y la nueva se crea ACTIVE con versión máximo + 1 (effectiveFrom = ahora). Mantiene serviceType y actorType; la configuración económica se envía completa. Nunca coexisten dos ACTIVE.' +
      notCharging,
  })
  createVersion(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateCreditPolicyVersionDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.policies.createVersion(id, dto, { userId: req.user.id });
  }
}
