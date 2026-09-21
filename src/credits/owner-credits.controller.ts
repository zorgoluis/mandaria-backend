import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
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
import {
  ProviderScopeDto,
  ProviderScopedPageDto,
} from '../delivery-assignments/delivery-assignments.dto.js';
import { CreditAccountsService } from './credit-accounts.service.js';
import { CreditLedgerQueryDto } from './credits.dto.js';
import {
  CreditAccountResponse,
  CreditLedgerPageResponse,
} from './credits.responses.js';

const readOnly =
  ' Sólo lectura: recargas y ajustes son exclusivos de SUPER_ADMIN y no existen en esta ruta. V1.10-A todavía no descuenta créditos al reclamar ni al tomar servicios.';

@ApiTags('Provider Credits')
@ApiBearerAuth()
@UseGuards(AccessGuard, RolesGuard, ProviderMembershipGuard)
@Roles('PROVIDER_ADMIN')
@Controller('provider/credits')
export class ProviderCreditsController {
  constructor(private readonly credits: CreditAccountsService) {}

  @Get()
  @ApiOkResponse({ type: CreditAccountResponse })
  @ApiErrorDescriptions({
    400: 'providerId inválido o campos desconocidos.',
    401: 'Se requiere access JWT humano de un User ACTIVE.',
    403: 'Rol global distinto de PROVIDER_ADMIN, o sin membership en el proveedor indicado: nunca se ve la cuenta de otro proveedor.',
    429: 'Límite de peticiones por IP excedido (100/minuto).',
    500: 'Error interno sanitizado.',
  })
  @ApiOperation({
    summary: 'Saldo de créditos de mi proveedor',
    description:
      'La cuenta única del proveedor de mi membership. La comparten todos sus Drivers de flotilla, que no tienen cuenta propia.' +
      readOnly +
      PROVIDER_SCOPE_DOC,
  })
  async get(
    @Query() _scope: ProviderScopeDto,
    @CurrentProvider() provider: ProviderProfile,
  ) {
    return this.credits.account(
      await this.credits.accountIdForProvider(provider.id),
    );
  }

  @Get('ledger')
  @ApiOkResponse({ type: CreditLedgerPageResponse })
  @ApiErrorDescriptions({
    400: 'providerId, page o pageSize inválidos.',
    401: 'Se requiere access JWT humano de un User ACTIVE.',
    403: 'Rol global distinto de PROVIDER_ADMIN, o sin membership en el proveedor indicado.',
    429: 'Límite de peticiones por IP excedido (100/minuto).',
    500: 'Error interno sanitizado.',
  })
  @ApiOperation({
    summary: 'Historial de créditos de mi proveedor',
    description:
      'Movimientos del más reciente al más antiguo, paginados (máximo 100 por página), con importe, saldo antes y después y motivo. No muestra qué SUPER_ADMIN registró cada movimiento ni su Idempotency-Key.' +
      readOnly +
      PROVIDER_SCOPE_DOC,
  })
  async ledger(
    @Query() query: ProviderScopedPageDto,
    @CurrentProvider() provider: ProviderProfile,
  ) {
    return this.credits.ledger(
      await this.credits.accountIdForProvider(provider.id),
      query,
      'OWNER',
    );
  }
}

@ApiTags('Driver Credits')
@ApiBearerAuth()
@UseGuards(AccessGuard, RolesGuard)
@Roles('DRIVER')
@Controller('driver/credits')
export class DriverCreditsController {
  constructor(private readonly credits: CreditAccountsService) {}

  @Get()
  @ApiOkResponse({ type: CreditAccountResponse })
  @ApiErrorDescriptions({
    400: 'Petición mal formada. Esta ruta no recibe parámetros: la cuenta se resuelve desde el JWT.',
    401: 'Se requiere access JWT humano de un User ACTIVE.',
    403: 'Rol global distinto de DRIVER.',
    404: 'Sin perfil Driver, o CREDIT_ACCOUNT_NOT_FOUND: un Driver de flotilla opera con la cuenta de su proveedor y no tiene cuenta propia; un independiente la obtiene al ser aprobado.',
    429: 'Límite de peticiones por IP excedido (100/minuto).',
    500: 'Error interno sanitizado.',
  })
  @ApiOperation({
    summary: 'Mi saldo de créditos como repartidor independiente',
    description:
      'La cuenta se resuelve desde el JWT, nunca desde un id enviado. Se puede consultar aunque el perfil esté SUSPENDED o REJECTED: el saldo y el historial se conservan.' +
      readOnly,
  })
  async get(@Req() req: AuthenticatedRequest) {
    return this.credits.account(
      await this.credits.accountIdForDriverUser(req.user.id),
    );
  }

  @Get('ledger')
  @ApiOkResponse({ type: CreditLedgerPageResponse })
  @ApiErrorDescriptions({
    400: 'page o pageSize inválidos.',
    401: 'Se requiere access JWT humano de un User ACTIVE.',
    403: 'Rol global distinto de DRIVER.',
    404: 'Sin perfil Driver o sin cuenta propia (CREDIT_ACCOUNT_NOT_FOUND).',
    429: 'Límite de peticiones por IP excedido (100/minuto).',
    500: 'Error interno sanitizado.',
  })
  @ApiOperation({
    summary: 'Mi historial de créditos',
    description:
      'Movimientos del más reciente al más antiguo, paginados (máximo 100 por página).' +
      readOnly,
  })
  async ledger(
    @Req() req: AuthenticatedRequest,
    @Query() query: CreditLedgerQueryDto,
  ) {
    return this.credits.ledger(
      await this.credits.accountIdForDriverUser(req.user.id),
      query,
      'OWNER',
    );
  }
}
