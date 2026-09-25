import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  B2B_DELIVERY_STATUSES,
  B2B_EXECUTION_MODES,
} from '../deliveries/delivery-status.js';
import type {
  B2bDeliveryStatus,
  B2bExecutionMode,
} from '../deliveries/delivery-status.js';

const dateTime = { format: 'date-time' } as const;

export class DeliveryExecutionResponse {
  @ApiProperty({
    enum: B2B_EXECUTION_MODES,
    description:
      'Quién ejecuta el servicio: PROVIDER (un proveedor con su flotilla) o INDEPENDENT (un repartidor independiente). No se exponen Driver, Vehicle ni membresías.',
  })
  mode!: B2bExecutionMode;
}

/**
 * V1.12-A public contract. Built field by field from the internal model — never a spread of a
 * Prisma row — so nothing new leaks into the B2B surface by accident.
 */
export class DeliveryStatusResponse {
  @ApiProperty({
    example: 'MDR-000123',
    description:
      'Identificador Mandaria de la solicitud, el mismo que usan el resto de rutas B2B.',
  })
  publicId!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'ORDER-4711',
    description:
      'La referencia que envió el cliente al crear la solicitud, tratada como texto opaco.',
  })
  externalReference!: string | null;

  @ApiProperty({
    enum: B2B_DELIVERY_STATUSES,
    description:
      'Estado logístico público y estable: REQUESTED (sin servicio publicado todavía), OPEN (publicado, esperando quien lo tome), ASSIGNED (alguien lo está ejecutando), DELIVERED (entregado), CANCELLED (cancelado antes de entregar) o EXPIRED (nadie lo tomó dentro de su ventana). No refleja uno a uno los estados internos.',
  })
  status!: B2bDeliveryStatus;

  @ApiPropertyOptional({
    type: DeliveryExecutionResponse,
    nullable: true,
    description:
      'Presente desde que alguien se adjudica el servicio; null mientras nadie lo ha tomado.',
  })
  execution!: DeliveryExecutionResponse | null;

  @ApiProperty({ ...dateTime, description: 'Cuándo se creó la solicitud.' })
  requestedAt!: Date;

  @ApiPropertyOptional({
    ...dateTime,
    type: String,
    nullable: true,
    description:
      'Momento de la entrega. null mientras no se ha entregado; nunca 0 ni cadena vacía.',
  })
  deliveredAt!: Date | null;

  @ApiPropertyOptional({
    ...dateTime,
    type: String,
    nullable: true,
    description:
      'Momento de la cancelación; null si la solicitud no está cancelada.',
  })
  cancelledAt!: Date | null;
}
