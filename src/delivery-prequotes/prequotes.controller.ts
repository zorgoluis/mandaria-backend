import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiErrorDescriptions } from '../common/api-errors.decorator.js';
import {
  IntegrationGuard,
  type IntegrationRequest,
} from '../integrations/integration.guard.js';
import {
  IntegrationScopes,
  IntegrationScopesGuard,
} from '../integrations/integration-scopes.js';
import { CreatePrequoteDto, PrequoteResponse } from './prequotes.dto.js';
import { PrequotesService } from './prequotes.service.js';
import { PrequotePublicError } from './prequote-errors.js';

@ApiTags('Delivery Prequotes (B2B)')
@ApiBearerAuth('integration-bearer')
@UseGuards(IntegrationGuard, IntegrationScopesGuard)
@Controller('delivery-prequotes')
export class PrequotesController {
  constructor(private readonly prequotes: PrequotesService) {}

  @Post()
  @IntegrationScopes('prequotes:create')
  @ApiBody({
    type: CreatePrequoteDto,
    description:
      'Sólo los campos documentados; desconocidos rechazados. No financialContext, integrationClientId, direcciones, contactos ni datos bancarios.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: {
      type: 'string',
      minLength: 8,
      maxLength: 255,
      pattern: '^[!-~]{8,255}$',
    },
    description:
      'Clave estable por intención y cliente, compartida con las operaciones legacy.',
  })
  @ApiCreatedResponse({
    type: PrequoteResponse,
    description:
      'Snapshot publicado. Idempotent-Replayed: false. Deshabilitada por defecto; requiere configuración y admisión compartida A5.',
  })
  @ApiOkResponse({
    type: PrequoteResponse,
    description:
      'Replay durable, Idempotent-Replayed: true; puede estar EXPIRED, sin routing ni renovar fechas.',
  })
  @ApiErrorDescriptions({
    400: 'PREQUOTE_CONDITIONS_INVALID | IDEMPOTENCY_KEY_INVALID. Sin reserva ni routing.',
    401: 'Token B2B inválido o estado/credencial revocados; PREQUOTE_AUTHORIZATION_CHANGED durante ejecución.',
    403: 'Requiere prequotes:create, no otorgado automáticamente.',
    409: 'HTTP_409: clave/cuerpo/operación incompatible. PREQUOTE_IN_PROGRESS: Retry-After hasta lease actual. PREQUOTE_PERMIT_INVALID | PREQUOTE_LEASE_LOST | PREQUOTE_LEASE_BUDGET_INSUFFICIENT | PREQUOTE_CONFIGURATION_CHANGED | ATTEMPTS_EXHAUSTED | PREQUOTE_FAILED (intención terminal). No significa éxito.',
    422: 'OUT_OF_SERVICE_AREA | CROSS_ZONE_NOT_SUPPORTED | ROUTE_NOT_FOUND | DISTANCE_NOT_SUPPORTED. Fallo terminal de esta intención.',
    429: 'PREQUOTE_CONSUMPTION_LIMIT: cuota móvil de 60s/24h, concurrencia o presupuesto global MPQ agotados. Retry-After refleja todos los límites bloqueantes, sin prometer admisión. Separado del límite HTTP de abuso.',
    503: 'PREQUOTE_DISABLED | PREQUOTE_CONSUMPTION_UNAVAILABLE (configuración global ausente/incoherente o infraestructura caída; sin plazo inventado). ROUTING_UNAVAILABLE | RATE_CONFIGURATION_UNAVAILABLE | RATE_CONFIGURATION_INVALID | SERVICE_ZONE_AMBIGUOUS | PREQUOTE_EXECUTION_FAILED. Reintentos con misma key acotados; sin Retry-After inventado. Leer code, message y requestId.',
  })
  @ApiOperation({
    summary: 'Emitir o recuperar mi precotización',
    description:
      'Requiere prequotes:create. Contrato A4: FOOD, MXN, inmediato y conditionsVersion=1 obligatorio. Autentica y normaliza antes de consultar la clave. Replay disponible aun deshabilitado. Nuevas emisiones requieren flag y permiso compartido; requieren configuración global explícita y coherente entre instancias; cuotas 10/min, 500/24h y 2 slots por integración por defecto. Consumo potencial conservador MAX_RETRIES+1 unidades por inicio, aun sin publicación. Routing fuera de transacciones; publicación con fencing y revalidación de configuración y autenticación. Una llamada al adaptador por intento, hasta presupuesto persistido. No crea solicitud, Quote, Dispatch ni movimientos. No hay conversión/aceptación.',
  })
  async create(
    @Req() req: IntegrationRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      const result = await this.prequotes.create(
        req.integration.id,
        req.headers.authorization!.slice(7),
        key ?? '',
        body,
      );
      res.status(result.replayed ? 200 : 201);
      res.setHeader('Idempotent-Replayed', String(result.replayed));
      return result.prequote;
    } catch (error) {
      if (
        error instanceof PrequotePublicError &&
        error.retryAt &&
        !error.terminal
      )
        res.setHeader(
          'Retry-After',
          String(
            Math.max(
              1,
              Math.ceil((error.retryAt.getTime() - Date.now()) / 1000),
            ),
          ),
        );
      throw error;
    }
  }

  @Get(':publicId')
  @IntegrationScopes('prequotes:read')
  @ApiParam({
    name: 'publicId',
    example: 'MPQ-000123',
    description: 'Identificador público de precotización propia.',
  })
  @ApiOkResponse({
    type: PrequoteResponse,
    description: 'Sólo snapshot propio; lectura sin routing ni escrituras.',
  })
  @ApiErrorDescriptions({
    400: 'Identificador inválido.',
    401: 'Token B2B inválido, integración/credencial inactiva.',
    403: 'Falta prequotes:read.',
    404: 'Ajena e inexistente indistinguibles.',
    429: 'Límite HTTP global.',
    500: 'Error interno sanitizado.',
  })
  @ApiOperation({
    summary: 'Consultar mi precotización',
    description:
      'Requiere prequotes:read y ownership. Disponible aun con emisión bloqueada. Estado efectivo OFFERED/EXPIRED; igualdad con expiresAt ya está vencida. Precio y zona congelados; sin datos internos, rutas de conversión o aceptación.',
  })
  get(@Req() req: IntegrationRequest, @Param('publicId') id: string) {
    if (!/^MPQ-\d{6,12}$/i.test(id))
      throw new BadRequestException('Invalid prequote publicId');
    return this.prequotes.get(id.toUpperCase(), req.integration.id);
  }
}
