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
      'Deshabilitar conserva la configuración y detiene las entregas: los eventos se siguen registrando y no se intenta ningún envío.',
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
  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

export class WebhookAttemptResponse {
  @ApiProperty({
    enum: ['attempted', 'skipped'],
    description:
      'skipped significa que no hubo petición HTTP porque el cliente no tiene endpoint o lo tiene deshabilitado; no es un fallo y no deja intento.',
  })
  kind!: 'attempted' | 'skipped';
  @ApiPropertyOptional({ format: 'uuid' })
  attemptId?: string;
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
  @ApiPropertyOptional({ enum: ['NO_ENDPOINT', 'ENDPOINT_DISABLED'] })
  reason?: string;
}
