import {
  BadRequestException,
  Body,
  Controller,
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
import {
  ConvertPrequoteDto,
  PrequoteConversionResponse,
} from './prequote-conversion.dto.js';
import { PrequoteConversionService } from './prequote-conversion.service.js';
@ApiTags('Delivery Prequotes (B2B)')
@ApiBearerAuth('integration-bearer')
@UseGuards(IntegrationGuard, IntegrationScopesGuard)
@Controller('delivery-prequotes')
export class PrequoteConversionController {
  constructor(private readonly conversion: PrequoteConversionService) {}
  @Post(':publicId/convert')
  @IntegrationScopes('prequotes:convert', 'deliveries:create', 'quotes:create')
  @ApiParam({
    name: 'publicId',
    example: 'MPQ-000101',
    description:
      'MPQ propia, vigente y no consumida para una conversión nueva.',
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
      'Namespace compartido con emisión y solicitudes legacy; no reutilizar para otra intención.',
  })
  @ApiBody({
    type: ConvertPrequoteDto,
    description:
      'Confirmación declarada por restaurante e intención RECIPIENT/CASH/DELIVERY/DELIVERY_FEE. Propiedades extra rechazadas; no comprobantes ni datos bancarios.',
  })
  @ApiCreatedResponse({
    type: PrequoteConversionResponse,
    description:
      'MDR PREPAID y MQ OFFERED atómicas. Idempotent-Replayed=false; Location hacia MDR (GET requiere deliveries:read). Cache-Control=no-store; X-Request-Id de servidor.',
  })
  @ApiOkResponse({
    type: PrequoteConversionResponse,
    description:
      'Idempotent-Replayed=true, mismos vínculos/expiry y estados actuales, incluso cancelada, vencida o flag apagado.',
  })
  @ApiErrorDescriptions({
    400: 'VALIDATION_ERROR | PREQUOTE_CONDITIONS_INVALID: body, fechas, key o condiciones inválidas.',
    401: 'Token B2B inválido, credencial revocada o integración suspendida.',
    403: 'Se requieren los tres scopes; no se otorgan automáticamente.',
    404: 'MPQ ajena o inexistente.',
    409: 'HTTP_409 (key incompatible), PREQUOTE_ALREADY_CONVERTED, PREQUOTE_EXPIRED, PREQUOTE_CONDITIONS_MISMATCH, PREQUOTE_SERVICE_UNAVAILABLE.',
    429: 'Límite HTTP de abuso; no consume presupuesto routing.',
    503: 'PREQUOTE_CONVERSION_DISABLED | PREQUOTE_CONVERSION_UNAVAILABLE. Reintentar misma key ante fallo transitorio; sin Retry-After inventado.',
  })
  @ApiOperation({
    summary: 'Convertir una precotización una sola vez',
    description:
      'Requiere prequotes:convert + deliveries:create + quotes:create y ownership B2B. Flag independiente false por defecto. Una transacción copia precio, ruta, tarifa y expiry MPQ sin routing ni recálculo. Zona INACTIVE impide nuevas conversiones; tarifa reemplazada no cambia snapshot. Registra declaración del integrador, no verificación bancaria. No acepta Quote, no abre Dispatch ni cobra créditos. La MQ convertida requiere aceptación autorizada; no admite aceptación sin atestación ni recotización sobre la misma solicitud. Cancelar no libera MPQ.',
  })
  async convert(
    @Req() req: IntegrationRequest,
    @Param('publicId') publicId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: ConvertPrequoteDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (
      !/^MPQ-\d{6,12}$/i.test(publicId) ||
      !key ||
      !/^[!-~]{8,255}$/.test(key)
    )
      throw new BadRequestException(['Invalid publicId or Idempotency-Key']);
    const outcome = await this.conversion.convert(
      req.integration.id,
      publicId.toUpperCase(),
      key,
      body,
    );
    res.status(outcome.replayed ? 200 : 201);
    res.setHeader('Idempotent-Replayed', String(outcome.replayed));
    if (!outcome.replayed)
      res.setHeader(
        'Location',
        '/api/v1/delivery-requests/' + outcome.result.deliveryRequestPublicId,
      );
    return outcome.result;
  }
}
