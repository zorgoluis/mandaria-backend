import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

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
}
