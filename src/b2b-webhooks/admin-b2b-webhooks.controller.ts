import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AccessGuard, Roles, RolesGuard } from '../auth/auth.guards.js';
import type { AuthenticatedRequest } from '../auth/auth.guards.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { B2bWebhooksService } from './b2b-webhooks.service.js';
import { WebhookTargetError } from './webhook-target.js';
import {
  UpsertWebhookEndpointDto,
  WebhookAttemptResponse,
  WebhookEndpointResponse,
} from './b2b-webhooks.dto.js';

const endpointSelect = {
  id: true,
  integrationClientId: true,
  url: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * V1.12-C: webhook configuration is an administrative act, not something a B2B client does with
 * its own credentials. The URL decides where Mandaria will connect from inside its own network, so
 * it stays with SUPER_ADMIN, on the same administrative surface that already manages
 * IntegrationClients and their credentials.
 */
@ApiTags('Admin B2B Webhooks')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Requires a human access token' })
@ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
@UseGuards(AccessGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller('admin')
export class AdminB2bWebhooksController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: B2bWebhooksService,
  ) {}

  @Get('integrations/:id/webhook')
  @ApiOkResponse({ type: WebhookEndpointResponse })
  @ApiOperation({
    summary: 'Consultar el endpoint de webhook de un IntegrationClient',
  })
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    const endpoint = await this.prisma.b2bWebhookEndpoint.findUnique({
      where: { integrationClientId: id },
      select: endpointSelect,
    });
    if (!endpoint) throw new NotFoundException('Webhook endpoint not found');
    return endpoint;
  }

  @Put('integrations/:id/webhook')
  @ApiOkResponse({ type: WebhookEndpointResponse })
  @ApiOperation({
    summary: 'Configurar el endpoint de webhook de un IntegrationClient',
    description:
      'Un endpoint por IntegrationClient en esta versión. La URL se valida como superficie SSRF al escribirla y otra vez al usarla, porque el DNS puede cambiar en medio. No existen todavía política de reintentos, cabeceras propias ni suscripción por tipo de evento: sólo existe delivery.completed.',
  })
  async upsert(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpsertWebhookEndpointDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const client = await this.prisma.integrationClient.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!client) throw new NotFoundException('IntegrationClient not found');
    try {
      this.webhooks.validateUrl(dto.url);
    } catch (error) {
      if (error instanceof WebhookTargetError)
        throw new BadRequestException([error.message]);
      throw error;
    }
    const enabled = dto.enabled ?? true;
    return this.prisma.b2bWebhookEndpoint.upsert({
      where: { integrationClientId: id },
      create: {
        integrationClientId: id,
        url: dto.url,
        enabled,
        createdByUserId: req.user.id,
        updatedByUserId: req.user.id,
      },
      update: { url: dto.url, enabled, updatedByUserId: req.user.id },
      select: endpointSelect,
    });
  }

  /**
   * Operational, not a test hook: it is how an administrator hands over an event whose first
   * attempt failed, while automatic retries do not exist yet. It performs exactly one attempt and
   * answers with its outcome, so the operator sees what happened instead of guessing.
   */
  @Post('b2b-events/:eventId/deliver')
  @HttpCode(200)
  @ApiOkResponse({ type: WebhookAttemptResponse })
  @ApiNoContentResponse({ description: 'No aplica.' })
  @ApiOperation({
    summary: 'Intentar entregar un evento B2B registrado',
    description:
      'Realiza **un** intento y registra su resultado. No hay reintentos automáticos en V1.12-C: un fallo queda como intento FAILED y se detiene ahí. No modifica el evento, que es inmutable, ni el Dispatch, ni los créditos.',
  })
  async deliver(@Param('eventId', new ParseUUIDPipe()) eventId: string) {
    const result = await this.webhooks.deliver(eventId);
    if (result.kind === 'skipped')
      return { kind: result.kind, reason: result.reason };
    const { outcome } = result;
    return {
      kind: result.kind,
      attemptId: result.attemptId,
      result: outcome.result,
      httpStatus:
        outcome.result === 'SUCCEEDED' ? outcome.httpStatus : outcome.httpStatus,
      failureKind: outcome.result === 'FAILED' ? outcome.failureKind : undefined,
      durationMs: outcome.durationMs,
    };
  }
}
