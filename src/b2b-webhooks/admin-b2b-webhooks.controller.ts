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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AccessGuard, Roles, RolesGuard } from '../auth/auth.guards.js';
import type { AuthenticatedRequest } from '../auth/auth.guards.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { B2bWebhooksService } from './b2b-webhooks.service.js';
import { WebhookOperationsService } from './webhook-operations.service.js';
import { redeliveryOutcome } from './webhook-operations.js';
import { WebhookTargetError } from './webhook-target.js';
import {
  WebhookSecretError,
  encryptSecret,
  newWebhookSecret,
} from './webhook-secret.js';
import {
  AdminEventDetailResponse,
  AdminEventListQueryDto,
  AdminEventPageResponse,
  UpsertWebhookEndpointDto,
  WebhookAttemptResponse,
  WebhookClientSummaryResponse,
  WebhookDeliveryResponse,
  WebhookEndpointResponse,
  WebhookHealthResponse,
  WebhookRescueResponse,
  WebhookSecretResponse,
} from './b2b-webhooks.dto.js';

/** Everything an administrator may see about an endpoint. The secret is never among it. */
const endpointSelect = {
  id: true,
  integrationClientId: true,
  url: true,
  enabled: true,
  deliverFrom: true,
  secretCiphertext: true,
  secretSetAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

type EndpointRow = {
  secretCiphertext: string | null;
  secretSetAt: Date | null;
} & Record<string, unknown>;

/** Turns a row into the response: presence of a secret, never the secret. */
const toEndpoint = ({ secretCiphertext, ...rest }: EndpointRow) => ({
  ...rest,
  secretConfigured: secretCiphertext !== null,
});

/**
 * V1.12-C/D: webhook configuration is an administrative act, not something a B2B client does with
 * its own credentials. The URL decides where Mandaria will connect from inside its own network and
 * the secret is what proves a request is Mandaria's, so both stay with SUPER_ADMIN, on the same
 * administrative surface that already manages IntegrationClients and their credentials.
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
    private readonly operations: WebhookOperationsService,
  ) {}

  @Get('integrations/:id/webhook')
  @ApiOkResponse({ type: WebhookEndpointResponse })
  @ApiOperation({
    summary: 'Consultar el endpoint de webhook de un IntegrationClient',
    description:
      'Devuelve la configuración y **si** hay secreto, nunca el secreto. El valor sólo se muestra una vez, al generarlo o rotarlo.',
  })
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    const endpoint = await this.prisma.b2bWebhookEndpoint.findUnique({
      where: { integrationClientId: id },
      select: endpointSelect,
    });
    if (!endpoint) throw new NotFoundException('Webhook endpoint not found');
    return toEndpoint(endpoint);
  }

  @Put('integrations/:id/webhook')
  @ApiOkResponse({ type: WebhookEndpointResponse })
  @ApiOperation({
    summary: 'Configurar el endpoint de webhook de un IntegrationClient',
    description:
      'Un endpoint por IntegrationClient. La URL se valida como superficie SSRF al escribirla y otra vez al usarla, porque el DNS puede cambiar en medio. Al crearlo, `deliverFrom` queda en este instante: sólo los eventos posteriores entran en la entrega automática, de modo que configurar un webhook hoy no dispara el historial. Deshabilitarlo detiene los envíos sin perder el estado; volver a habilitarlo los reanuda desde donde iban.',
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
    const endpoint = await this.prisma.b2bWebhookEndpoint.upsert({
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
    return toEndpoint(endpoint);
  }

  /**
   * Issues or rotates the signing secret. It is generated here with the CSPRNG rather than chosen,
   * stored encrypted, and returned **once**: this response is the only moment it exists in plain
   * text outside the signing code.
   */
  @Post('integrations/:id/webhook/secret')
  @HttpCode(200)
  @ApiOkResponse({ type: WebhookSecretResponse })
  @ApiOperation({
    summary: 'Generar o rotar el secreto de firma del webhook',
    description:
      'El secreto se genera con CSPRNG, se guarda cifrado (AES-256-GCM bajo `B2B_WEBHOOK_SECRET_KEY`) y **se devuelve una sola vez**: después sólo es visible que existe. Rotar no recrea el IntegrationClient ni toca el historial: cada intento firma con el secreto activo en ese momento, así que un reintento posterior a la rotación ya viaja con el nuevo y las firmas antiguas no se regeneran.',
  })
  async issueSecret(@Param('id', new ParseUUIDPipe()) id: string) {
    const endpoint = await this.prisma.b2bWebhookEndpoint.findUnique({
      where: { integrationClientId: id },
      select: { id: true },
    });
    if (!endpoint) throw new NotFoundException('Webhook endpoint not found');
    const secret = newWebhookSecret();
    let ciphertext: string;
    try {
      ciphertext = encryptSecret(secret, this.webhooks.key());
    } catch (error) {
      if (error instanceof WebhookSecretError)
        throw new BadRequestException([error.message]);
      throw error;
    }
    const saved = await this.prisma.b2bWebhookEndpoint.update({
      where: { id: endpoint.id },
      data: { secretCiphertext: ciphertext, secretSetAt: new Date() },
      select: { secretSetAt: true },
    });
    return {
      secret,
      secretSetAt: saved.secretSetAt,
      algorithm: 'HMAC-SHA256',
      signatureHeader: 'X-Mandaria-Signature',
      signedMessage: '{timestamp}.{rawBody}',
      note: 'Guárdalo ahora: no vuelve a mostrarse.',
    };
  }

  /** What is still owed to this client, and how it is going. */
  @Get('integrations/:id/webhook/deliveries')
  @ApiOkResponse({ type: WebhookDeliveryResponse, isArray: true })
  @ApiOperation({
    summary: 'Estado de entrega de los eventos de un IntegrationClient',
    description:
      'Hasta 100 entregas, las más recientes primero: estado, intentos hechos, próximo intento y el resultado del último. No expone el secreto ni el cuerpo del evento.',
  })
  async deliveries(@Param('id', new ParseUUIDPipe()) id: string) {
    const rows = await this.prisma.b2bWebhookDelivery.findMany({
      where: { integrationClientId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        eventId: true,
        state: true,
        attemptCount: true,
        nextAttemptAt: true,
        lastAttemptAt: true,
        deliveredAt: true,
        exhaustedAt: true,
        leaseExpiresAt: true,
      },
    });
    const last = await this.prisma.b2bWebhookDeliveryAttempt.findMany({
      where: { eventId: { in: rows.map((r) => r.eventId) } },
      orderBy: { attemptedAt: 'desc' },
      select: {
        eventId: true,
        result: true,
        httpStatus: true,
        failureKind: true,
        attemptedAt: true,
      },
    });
    const latest = new Map<string, (typeof last)[number]>();
    for (const attempt of last)
      if (!latest.has(attempt.eventId)) latest.set(attempt.eventId, attempt);
    return rows.map((row) => ({
      ...row,
      lastResult: latest.get(row.eventId)?.result ?? null,
      lastHttpStatus: latest.get(row.eventId)?.httpStatus ?? null,
      lastFailureKind: latest.get(row.eventId)?.failureKind ?? null,
    }));
  }

  /**
   * Operational, not a test hook: it is how an administrator hands over an event whose retries ran
   * out, and the only way an event older than the boundary is delivered at all.
   */
  @Post('b2b-events/:eventId/deliver')
  @HttpCode(200)
  @ApiOkResponse({ type: WebhookAttemptResponse })
  @ApiOperation({
    summary: 'Intentar entregar un evento B2B registrado',
    description:
      'Realiza **un** intento y registra su resultado. Toma el lease antes, así que nunca corre en paralelo con el worker: si éste lo tiene en ese momento, responde 409. Un evento PENDING avanza su calendario normalmente; uno EXHAUSTED puede pasar a DELIVERED si ahora responde; uno ya DELIVERED se reenvía a propósito y queda auditado sin cambiar de estado; uno anterior a la frontera se envía como en V1.12-C, sin crear estado ni entrar al ciclo de reintentos. No modifica el evento, que es inmutable, ni el Dispatch, ni los créditos.',
  })
  async deliver(
    @Param('eventId', new ParseUUIDPipe()) eventId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    // Audited before anything is tried, so a request that then fails is still on record as having
    // been made by a person.
    this.operations.logRedeliveryRequest(eventId, req.user.id);
    const result = await this.webhooks.deliver(eventId);
    if (result.kind === 'skipped')
      return {
        kind: result.kind,
        reason: result.reason,
        outcome: redeliveryOutcome(result),
      };
    return {
      kind: result.kind,
      attemptId: result.attemptId,
      attemptNumber: result.attemptNumber ?? undefined,
      result: result.outcome.result,
      httpStatus: result.outcome.httpStatus,
      failureKind:
        result.outcome.result === 'FAILED'
          ? result.outcome.failureKind
          : undefined,
      durationMs: result.outcome.durationMs,
      state: result.state,
      nextAttemptAt: result.nextAttemptAt ?? undefined,
      // What actually happened, in the operator's words: delivered, rescheduled for later,
      // out of attempts, or not tried at all. A screen must never read a 200 here as «sent».
      outcome: redeliveryOutcome({
        kind: result.kind,
        outcomeResult: result.outcome.result,
        state: result.state,
      }),
    };
  }

  /** V1.12-E: what Mandaria owes its B2B clients, answerable without opening a SQL console. */
  @Get('b2b-events')
  @ApiOkResponse({ type: AdminEventPageResponse })
  @ApiOperation({
    summary: 'Listar eventos B2B y su estado de transporte',
    description:
      'Tres conceptos distintos conviven aquí: el **evento** es un hecho inmutable y no tiene estado; el **transporte** sí lo tiene (PENDING, DELIVERED, EXHAUSTED, y el derivado NO_DELIVERY); y los **intentos** son historia. Orden por `occurredAt` descendente con el id como desempate estable. Filtros por cliente, tipo, estado de transporte, `publicId`, referencia externa y rango de fechas.',
  })
  events(@Query() query: AdminEventListQueryDto) {
    return this.operations.list(query);
  }

  @Get('b2b-events/:eventId')
  @ApiOkResponse({ type: AdminEventDetailResponse })
  @ApiOperation({
    summary: 'Diagnóstico completo de un evento B2B',
    description:
      'Reúne en una respuesta el sobre, la instantánea pública congelada que el cliente debía recibir, su dueño, el destino configurado, el estado del transporte y el historial de intentos. Nunca incluye el secreto, ni cifrado ni descifrado.',
  })
  event(@Param('eventId', new ParseUUIDPipe()) eventId: string) {
    return this.operations.detail(eventId);
  }

  /**
   * Puts an exhausted handover back in the queue. It does not attempt anything here, which is why
   * the answer says «rescheduled» and never «delivered».
   */
  @Post('b2b-events/:eventId/rescue')
  @HttpCode(200)
  @ApiOkResponse({ type: WebhookRescueResponse })
  @ApiOperation({
    summary: 'Devolver a la cola un evento con los reintentos agotados',
    description:
      'EXHAUSTED → PENDING, con el próximo intento ahora. **No intenta nada aquí**: programa trabajo y el worker lo recoge, así que la respuesta dice `RESCHEDULED` y nunca «entregado». No borra intentos, no reinicia el contador y no toca el evento; como el contador sigue donde estaba, un rescate compra un intento más y, si vuelve a fallar, regresa a EXHAUSTED y puede rescatarse otra vez. Dos rescates simultáneos no se duplican: el segundo encuentra la entrega ya pendiente y lo dice. Para intentarlo en el momento, usar `POST /admin/b2b-events/{eventId}/deliver`.',
  })
  rescue(
    @Param('eventId', new ParseUUIDPipe()) eventId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.operations.rescue(eventId, req.user.id);
  }

  @Get('webhooks/health')
  @ApiOkResponse({ type: WebhookHealthResponse })
  @ApiOperation({
    summary: 'Cuánto trabajo de webhooks queda, y qué hace esta instancia',
    description:
      'Los conteos son persistidos y compartidos por todos los backends. `thisInstance` es configuración y memoria **de la instancia que responde**: con varios backends corriendo el mismo bucle, ninguno sabe lo que hacen los demás, así que esto no es salud global y no se presenta como tal.',
  })
  health() {
    return this.operations.health();
  }

  @Get('integrations/:id/webhook/summary')
  @ApiOkResponse({ type: WebhookClientSummaryResponse })
  @ApiOperation({
    summary: 'Resumen de entregas de un IntegrationClient',
  })
  summary(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.operations.summaryFor(id);
  }
}
