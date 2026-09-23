import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AccessGuard, Roles, RolesGuard } from '../auth/auth.guards.js';
import type { AuthenticatedRequest } from '../auth/auth.guards.js';
import { ApiErrorDescriptions } from '../common/api-errors.decorator.js';
import { CreditAccountsService } from './credit-accounts.service.js';
import {
  AdjustCreditsDto,
  CreditLedgerQueryDto,
  RechargeCreditsDto,
} from './credits.dto.js';
import {
  AdminCreditLedgerPageResponse,
  CreditAccountResponse,
} from './credits.responses.js';
import {
  DriverParam,
  MovementDocs,
  ProviderParam,
  adminCreditErrors,
  movementConflicts,
  movementStatus,
  readIdempotencyKey,
} from './credits.http.js';

const noCharging =
  ' V1.10-A sólo registra cuentas y movimientos manuales: CLAIM de proveedor y TAKE independiente todavía NO consumen créditos.';

@ApiTags('Admin Credits')
@ApiBearerAuth()
@UseGuards(AccessGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller('admin/providers/:providerId/credits')
export class AdminProviderCreditsController {
  constructor(private readonly credits: CreditAccountsService) {}

  @Get()
  @ProviderParam()
  @ApiOkResponse({ type: CreditAccountResponse })
  @ApiErrorDescriptions(adminCreditErrors)
  @ApiOperation({
    summary: 'Consultar la cuenta de créditos de un proveedor',
    description:
      'Cuenta única del proveedor, que usan todos sus Drivers de flotilla. Existe desde que se crea el proveedor (y la migración la creó con saldo 0 para los existentes), cualquiera que sea su estado: suspender un proveedor no borra ni congela su saldo ni su historial.' +
      noCharging,
  })
  async get(@Param('providerId', new ParseUUIDPipe()) providerId: string) {
    return this.credits.account(
      await this.credits.accountIdForProvider(providerId),
    );
  }

  @Get('ledger')
  @ProviderParam()
  @ApiOkResponse({ type: AdminCreditLedgerPageResponse })
  @ApiErrorDescriptions(adminCreditErrors)
  @ApiOperation({
    summary: 'Historial de créditos de un proveedor',
    description:
      'Movimientos del más reciente al más antiguo (por sequence), paginados (máximo 100 por página). Incluye quién registró cada movimiento y su Idempotency-Key. El historial es inmutable: no existe edición ni borrado.',
  })
  async ledger(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Query() query: CreditLedgerQueryDto,
  ) {
    return this.credits.ledger(
      await this.credits.accountIdForProvider(providerId),
      query,
      'ADMIN',
    );
  }

  @Post('recharge')
  @ProviderParam()
  @MovementDocs()
  @ApiErrorDescriptions({ ...adminCreditErrors, 409: movementConflicts })
  @ApiOperation({
    summary: 'Recargar créditos a un proveedor',
    description:
      'SUPER_ADMIN declara que el pago se confirmó fuera de Mandaria (transferencia, efectivo u otro) y suma créditos enteros. Mandaria no procesa ni verifica ese pago. En una sola transacción bloquea la cuenta, registra un movimiento RECHARGE con saldo antes y después, y actualiza el saldo. Requiere Idempotency-Key.' +
      noCharging,
  })
  async recharge(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: RechargeCreditsDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const idempotencyKey = readIdempotencyKey(key);
    const { replayed, ...movement } = await this.credits.recharge(
      await this.credits.accountIdForProvider(providerId),
      dto,
      idempotencyKey,
      { userId: req.user.id },
    );
    movementStatus(res, replayed);
    return movement;
  }

  @Post('adjustment')
  @ProviderParam()
  @MovementDocs()
  @ApiErrorDescriptions({ ...adminCreditErrors, 409: movementConflicts })
  @ApiOperation({
    summary: 'Ajustar créditos de un proveedor',
    description:
      'Corrección administrativa explícita, separada de la recarga: suma o resta créditos enteros (nunca 0) con motivo obligatorio. Nunca deja el saldo negativo: si el ajuste lo haría, responde 409 INSUFFICIENT_CREDITS y no aplica nada. Requiere Idempotency-Key.',
  })
  async adjustment(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: AdjustCreditsDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const idempotencyKey = readIdempotencyKey(key);
    const { replayed, ...movement } = await this.credits.adjust(
      await this.credits.accountIdForProvider(providerId),
      dto,
      idempotencyKey,
      { userId: req.user.id },
    );
    movementStatus(res, replayed);
    return movement;
  }
}

@ApiTags('Admin Credits')
@ApiBearerAuth()
@UseGuards(AccessGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller('admin/drivers/:driverId/independent/credits')
export class AdminIndependentCreditsController {
  constructor(private readonly credits: CreditAccountsService) {}

  @Get()
  @DriverParam()
  @ApiOkResponse({ type: CreditAccountResponse })
  @ApiErrorDescriptions(adminCreditErrors)
  @ApiOperation({
    summary: 'Consultar la cuenta de créditos de un repartidor independiente',
    description:
      'La cuenta pertenece a la capacidad independiente, no al User: se crea la primera vez que el perfil llega a APPROVED y se conserva aunque después quede SUSPENDED o REJECTED. Un Driver de flotilla o un independiente nunca aprobado no tiene cuenta propia (404 CREDIT_ACCOUNT_NOT_FOUND).' +
      noCharging,
  })
  async get(@Param('driverId', new ParseUUIDPipe()) driverId: string) {
    return this.credits.account(
      await this.credits.accountIdForIndependentDriver(driverId),
    );
  }

  @Get('ledger')
  @DriverParam()
  @ApiOkResponse({ type: AdminCreditLedgerPageResponse })
  @ApiErrorDescriptions(adminCreditErrors)
  @ApiOperation({
    summary: 'Historial de créditos de un repartidor independiente',
    description:
      'Movimientos del más reciente al más antiguo (por sequence), paginados (máximo 100 por página), con actor e Idempotency-Key.',
  })
  async ledger(
    @Param('driverId', new ParseUUIDPipe()) driverId: string,
    @Query() query: CreditLedgerQueryDto,
  ) {
    return this.credits.ledger(
      await this.credits.accountIdForIndependentDriver(driverId),
      query,
      'ADMIN',
    );
  }

  @Post('recharge')
  @DriverParam()
  @MovementDocs()
  @ApiErrorDescriptions({ ...adminCreditErrors, 409: movementConflicts })
  @ApiOperation({
    summary: 'Recargar créditos a un repartidor independiente',
    description:
      'Mismo contrato que la recarga de proveedor: pago confirmado fuera de Mandaria, créditos enteros, movimiento RECHARGE atómico e Idempotency-Key obligatoria. Permitida aunque el perfil esté SUSPENDED: la cuenta y su historia se conservan y la decisión es administrativa.' +
      noCharging,
  })
  async recharge(
    @Param('driverId', new ParseUUIDPipe()) driverId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: RechargeCreditsDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const idempotencyKey = readIdempotencyKey(key);
    const { replayed, ...movement } = await this.credits.recharge(
      await this.credits.accountIdForIndependentDriver(driverId),
      dto,
      idempotencyKey,
      { userId: req.user.id },
    );
    movementStatus(res, replayed);
    return movement;
  }

  @Post('adjustment')
  @DriverParam()
  @MovementDocs()
  @ApiErrorDescriptions({ ...adminCreditErrors, 409: movementConflicts })
  @ApiOperation({
    summary: 'Ajustar créditos de un repartidor independiente',
    description:
      'Suma o resta créditos enteros (nunca 0) con motivo obligatorio; nunca deja el saldo negativo. Requiere Idempotency-Key.',
  })
  async adjustment(
    @Param('driverId', new ParseUUIDPipe()) driverId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: AdjustCreditsDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const idempotencyKey = readIdempotencyKey(key);
    const { replayed, ...movement } = await this.credits.adjust(
      await this.credits.accountIdForIndependentDriver(driverId),
      dto,
      idempotencyKey,
      { userId: req.user.id },
    );
    movementStatus(res, replayed);
    return movement;
  }
}
