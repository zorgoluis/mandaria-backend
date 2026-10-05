import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { ApiErrorDescriptions } from '../common/api-errors.decorator.js';
import { CreatePartnerApplicationDto } from './partner-applications.dto.js';
import { PartnerApplicationReceiptResponse } from './partner-applications.responses.js';
import { PartnerApplicationsService } from './partner-applications.service.js';
import { HoneypotInterceptor } from './honeypot.interceptor.js';

/** Public, unauthenticated capture from the landing form. Never touches authentication. */
@ApiTags('Public Partner Applications')
@Controller('public/partner-applications')
export class PublicPartnerApplicationsController {
  constructor(private readonly applications: PartnerApplicationsService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @UseInterceptors(HoneypotInterceptor)
  @ApiAcceptedResponse({
    type: PartnerApplicationReceiptResponse,
    description:
      'Solicitud recibida. También para un duplicado (misma referencia) y para un honeypot lleno (referencia sin persistir).',
  })
  @ApiErrorDescriptions({
    400: 'VALIDATION_ERROR: campos inválidos o desconocidos. La landing no depende del texto de errors.',
    413: 'Cuerpo mayor a 16 kB.',
    429: 'Límite de envíos: 5 cada 10 minutos por IP (además del global de 100/minuto).',
    500: 'Error interno sanitizado.',
  })
  @ApiOperation({
    summary: 'Enviar solicitud de socio (landing)',
    description:
      'Sin autenticación. Crea un lead, nunca una cuenta. Una solicitud abierta (RECEIVED/CONTACTED) de los últimos 30 días con el mismo teléfono o correo absorbe el envío: misma referencia y submissionCount + 1. El honeypot `website` debe venir vacío o ausente.',
  })
  submit(
    @Body() dto: CreatePartnerApplicationDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.applications.submit(dto, res.locals.requestId as string);
  }
}
