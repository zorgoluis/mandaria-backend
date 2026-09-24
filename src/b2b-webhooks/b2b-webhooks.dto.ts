import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { B2bEventType } from '@prisma/client';
import { PaginationQueryDto } from '../common/pagination.dto.js';
import {
  NO_DELIVERY_REASONS,
  REDELIVERY_OUTCOMES,
  TRANSPORT_STATES,
} from './webhook-operations.js';

export class UpsertWebhookEndpointDto {
  @ApiProperty({
    example: 'https://coita-eats.example.com/hooks/mandaria',
    maxLength: 2048,
    description:
      'Destino HTTPS al que Mandaria entregará los eventos de este IntegrationClient. Se valida como superficie SSRF: sin credenciales embebidas, sin fragmento, y nunca hacia loopback, direcciones privadas, link-local (incluido el endpoint de metadatos) ni nombres internos. En LOCAL/TEST, con B2B_WEBHOOK_ALLOW_INSECURE_TARGETS=true, se admite http y localhost; en producción el arranque falla si ese interruptor está activo.',
  })
  @IsString()
  @MaxLength(2048)
  url!: string;

  @ApiPropertyOptional({
    default: true,
    description:
      'Deshabilitar conserva la configuración y detiene las entregas: los eventos se siguen registrando, el estado de entrega se conserva y el worker no los toca hasta volver a habilitarlo.',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class WebhookEndpointResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty({ format: 'uuid' })
  integrationClientId!: string;
  @ApiProperty({ example: 'https://coita-eats.example.com/hooks/mandaria' })
  url!: string;
  @ApiProperty()
  enabled!: boolean;
  @ApiProperty({
    description:
      'Si hay secreto de firma configurado. El secreto en sí no se devuelve nunca.',
  })
  secretConfigured!: boolean;
  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  secretSetAt!: Date | null;
  @ApiProperty({
    format: 'date-time',
    description:
      'Frontera de la entrega automática: sólo los eventos ocurridos a partir de este instante entran al worker. Los anteriores siguen siendo entregables a mano.',
  })
  deliverFrom!: Date;
  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

export class WebhookSecretResponse {
  @ApiProperty({
    description:
      'El secreto en claro. **Se muestra una sola vez**; después sólo es visible que existe.',
  })
  secret!: string;
  @ApiProperty({ format: 'date-time' })
  secretSetAt!: Date | null;
  @ApiProperty({ example: 'HMAC-SHA256' })
  algorithm!: string;
  @ApiProperty({ example: 'X-Mandaria-Signature' })
  signatureHeader!: string;
  @ApiProperty({
    example: '{timestamp}.{rawBody}',
    description:
      'Mensaje firmado: el valor de X-Mandaria-Timestamp, un punto, y los bytes exactos del cuerpo recibido. La firma viaja como `v1=<hex>`.',
  })
  signedMessage!: string;
  @ApiProperty()
  note!: string;
}

export class WebhookDeliveryResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty({ format: 'uuid' })
  eventId!: string;
  @ApiProperty({ enum: ['PENDING', 'DELIVERED', 'EXHAUSTED'] })
  state!: string;
  @ApiProperty()
  attemptCount!: number;
  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  nextAttemptAt!: Date | null;
  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  lastAttemptAt!: Date | null;
  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  deliveredAt!: Date | null;
  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  exhaustedAt!: Date | null;
  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
    description: 'Hasta cuándo un worker tiene tomada esta entrega.',
  })
  leaseExpiresAt!: Date | null;
  @ApiPropertyOptional({ enum: ['SUCCEEDED', 'FAILED'], nullable: true })
  lastResult!: string | null;
  @ApiPropertyOptional({ nullable: true })
  lastHttpStatus!: number | null;
  @ApiPropertyOptional({ nullable: true })
  lastFailureKind!: string | null;
}

export class WebhookAttemptResponse {
  @ApiProperty({
    enum: ['attempted', 'skipped'],
    description:
      'skipped significa que no hubo petición HTTP porque el cliente no tiene endpoint, lo tiene deshabilitado o aún no tiene secreto; no es un fallo y no deja intento.',
  })
  kind!: 'attempted' | 'skipped';
  @ApiPropertyOptional({ format: 'uuid' })
  attemptId?: string;
  @ApiPropertyOptional({
    description:
      'Ordinal del intento dentro de la entrega fiable. Ausente para un evento anterior a la frontera, que se entrega sin estado.',
  })
  attemptNumber?: number;
  @ApiPropertyOptional({ enum: ['SUCCEEDED', 'FAILED'] })
  result?: 'SUCCEEDED' | 'FAILED';
  @ApiPropertyOptional({
    description: 'Presente sólo cuando el endpoint respondió.',
  })
  httpStatus?: number;
  @ApiPropertyOptional({
    enum: ['HTTP_STATUS', 'TIMEOUT', 'NETWORK', 'INVALID_ENDPOINT'],
  })
  failureKind?: string;
  @ApiPropertyOptional()
  durationMs?: number;
  @ApiPropertyOptional({
    enum: ['PENDING', 'DELIVERED', 'EXHAUSTED', 'UNTRACKED'],
    description:
      'UNTRACKED: el evento es anterior a la frontera y se entregó sin crear estado ni entrar al ciclo de reintentos.',
  })
  state?: string;
  @ApiPropertyOptional({ format: 'date-time' })
  nextAttemptAt?: Date;
  @ApiPropertyOptional({
    enum: ['NO_ENDPOINT', 'ENDPOINT_DISABLED', 'NO_SECRET'],
  })
  reason?: string;
  @ApiPropertyOptional({
    enum: REDELIVERY_OUTCOMES,
    description:
      'Qué ocurrió, en términos operativos: DELIVERED (el receptor aceptó), RESCHEDULED (falló y hay otro intento programado), EXHAUSTED (falló y ya no habrá más), FAILED o SKIPPED (no se intentó nada). Una pantalla no debe leer el 200 de esta ruta como «enviado».',
  })
  outcome?: string;
}

/** V1.12-E: filters an operator actually needs, not a generic search engine. */
export class AdminEventListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Eventos de este IntegrationClient.',
  })
  @IsOptional()
  @IsUUID()
  integrationClientId?: string;

  @ApiPropertyOptional({
    enum: B2bEventType,
    description: 'Tipo interno del evento; hoy sólo existe DELIVERY_COMPLETED.',
  })
  @IsOptional()
  @IsEnum(B2bEventType)
  type?: B2bEventType;

  @ApiPropertyOptional({
    enum: TRANSPORT_STATES,
    description:
      'Estado del **transporte**, no del evento. NO_DELIVERY es derivado: el evento existe y es legítimo, pero está fuera de la entrega fiable (sin endpoint, anterior a la frontera, o todavía sin recoger).',
  })
  @IsOptional()
  @IsIn(TRANSPORT_STATES as unknown as string[])
  transportState?: (typeof TRANSPORT_STATES)[number];

  @ApiPropertyOptional({
    example: 'MDR-000123',
    description: 'La DeliveryRequest del evento, por su identificador público.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  deliveryRequestPublicId?: string;

  @ApiPropertyOptional({
    example: 'ORDER-4711',
    description:
      'Referencia externa exacta del cliente: por dónde empieza «mi pedido X no recibió actualización».',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  externalReference?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601()
  occurredFrom?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601()
  occurredTo?: string;
}

export class AdminEventSummaryResponse {
  @ApiProperty({ format: 'uuid' })
  eventId!: string;
  @ApiProperty({ example: 'delivery.completed' })
  type!: string;
  @ApiProperty({ format: 'date-time' })
  occurredAt!: Date;
  @ApiProperty({ format: 'date-time' })
  recordedAt!: Date;
  @ApiProperty({ format: 'uuid' })
  integrationClientId!: string;
  @ApiProperty()
  integrationClientName!: string;
  @ApiProperty()
  integrationClientCode!: string;
  @ApiProperty({ example: 'MDR-000123' })
  deliveryRequestPublicId!: string;
  @ApiPropertyOptional({ nullable: true, example: 'ORDER-4711' })
  externalReference!: string | null;
  @ApiProperty({
    enum: TRANSPORT_STATES,
    description:
      'Estado del transporte. El evento en sí no tiene estado: ocurrió.',
  })
  transportState!: string;
  @ApiPropertyOptional({
    enum: NO_DELIVERY_REASONS,
    nullable: true,
    description:
      'Por qué está fuera de la entrega fiable. Ninguno es un fallo.',
  })
  noDeliveryReason!: string | null;
  @ApiProperty()
  attemptCount!: number;
  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  lastAttemptAt!: Date | null;
  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  nextAttemptAt!: Date | null;
  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  deliveredAt!: Date | null;
  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  exhaustedAt!: Date | null;
  @ApiProperty({ description: 'Un worker lo tiene tomado en este momento.' })
  inFlight!: boolean;
}

export class AdminEventPageResponse {
  @ApiProperty({ type: AdminEventSummaryResponse, isArray: true })
  items!: AdminEventSummaryResponse[];
  @ApiProperty()
  total!: number;
  @ApiProperty()
  page!: number;
  @ApiProperty()
  pageSize!: number;
  @ApiProperty()
  totalPages!: number;
}

export class AdminAttemptResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Nulo en los intentos de V1.12-C.',
  })
  attemptNumber!: number | null;
  @ApiProperty({ format: 'date-time' })
  attemptedAt!: Date;
  @ApiProperty()
  durationMs!: number;
  @ApiProperty({ enum: ['SUCCEEDED', 'FAILED'] })
  result!: string;
  @ApiPropertyOptional({ nullable: true })
  httpStatus!: number | null;
  @ApiPropertyOptional({
    enum: ['HTTP_STATUS', 'TIMEOUT', 'NETWORK', 'INVALID_ENDPOINT'],
    nullable: true,
  })
  failureKind!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Clasificación saneada y acotada. Nunca el cuerpo remoto ni una traza interna.',
  })
  failureDetail!: string | null;
  @ApiProperty({ description: 'La URL exacta a la que fue este intento.' })
  endpointUrl!: string;
}

export class AdminEventDetailResponse extends AdminEventSummaryResponse {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'La instantánea pública congelada de V1.12-B: exactamente lo que el cliente debía recibir. No se reconstruye.',
  })
  payload!: unknown;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Configuración del destino. Nunca incluye el secreto ni su cifrado.',
  })
  endpoint!: {
    id: string;
    url: string;
    enabled: boolean;
    deliverFrom: Date;
    secretConfigured: boolean;
    secretSetAt: Date | null;
  } | null;
  @ApiProperty({ type: AdminAttemptResponse, isArray: true })
  attempts!: AdminAttemptResponse[];
}

export class WebhookRescueResponse {
  @ApiProperty({
    enum: ['RESCHEDULED', 'ALREADY_PENDING'],
    description:
      'RESCHEDULED: volvió a la cola y el worker lo tomará. ALREADY_PENDING: ya estaba pendiente y no se hizo nada. **No** significa entregado: aquí no se intenta nada.',
  })
  outcome!: string;
  @ApiProperty({ format: 'uuid' })
  eventId!: string;
}

export class WebhookHealthResponse {
  @ApiProperty({ description: 'Entregas pendientes en toda la base.' })
  pending!: number;
  @ApiProperty()
  exhausted!: number;
  @ApiProperty()
  delivered!: number;
  @ApiProperty({ description: 'Tomadas por algún worker ahora mismo.' })
  leased!: number;
  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  oldestPendingDueAt!: Date | null;
  @ApiProperty({
    description:
      'Configuración y memoria de **esta** instancia. Con varios backends, ninguno conoce el estado de los demás: no es salud global.',
  })
  thisInstance!: {
    workerEnabled: boolean;
    pollSeconds: number;
    leaseSeconds: number;
    lastPollAt: Date | null;
  };
}

export class WebhookClientSummaryResponse {
  @ApiProperty()
  events!: number;
  @ApiProperty()
  pending!: number;
  @ApiProperty()
  delivered!: number;
  @ApiProperty()
  exhausted!: number;
}
