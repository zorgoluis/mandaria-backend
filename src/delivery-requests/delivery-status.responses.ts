import { DispatchSearchResponse } from '../dispatch/dispatch-search.js';
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

export class PublicExecutionNameResponse {
  @ApiProperty({
    example: 'Nombre público',
    description:
      'Identidad exclusivamente de presentación; no es un identificador ni garantiza unicidad.',
  })
  displayName!: string;
}

export class DeliveryExecutionResponse {
  @ApiProperty({
    enum: B2B_EXECUTION_MODES,
    description:
      'Quién ejecuta el servicio: PROVIDER (un proveedor con su flotilla) o INDEPENDENT (un repartidor independiente). No se exponen Driver, Vehicle ni membresías.',
  })
  mode!: B2bExecutionMode;
  @ApiProperty({
    type: PublicExecutionNameResponse,
    nullable: true,
    description:
      'Nombre visible del proveedor. null para INDEPENDENT o si no existe evidencia pública histórica.',
  })
  provider!: PublicExecutionNameResponse | null;
  @ApiProperty({
    type: PublicExecutionNameResponse,
    nullable: true,
    description:
      'displayName configurado explícitamente del Driver vigente. null sin asignación o identidad pública. Nunca se deriva del nombre operativo o del User.',
  })
  driver!: PublicExecutionNameResponse | null;
}

/**
 * V1.12-A public contract. Built field by field from the internal model — never a spread of a
 * Prisma row — so nothing new leaks into the B2B surface by accident.
 */
export class DeliveryStatusResponse {
  @ApiPropertyOptional({ type: DispatchSearchResponse })
  search?: DispatchSearchResponse;
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
      'null antes de adjudicar o después de release. ASSIGNED muestra identidad vigente; DELIVERED usa snapshot histórico inmutable. Entregas anteriores sin evidencia conservan mode con provider/driver null. CANCELLED conserva mode histórico, con ambas identidades null.',
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

const statusExample = (status: string, execution: unknown) => ({
  publicId: 'MDR-000123',
  externalReference: 'ORDER-4711',
  status,
  execution,
  requestedAt: '2026-09-28T10:00:00.000Z',
  deliveredAt: status === 'DELIVERED' ? '2026-09-28T10:30:00.000Z' : null,
  cancelledAt: null,
});
export const PUBLIC_EXECUTION_EXAMPLES = {
  open: { summary: 'open', value: statusExample('OPEN', null) },
  providerClaimed: {
    summary: 'providerClaimed',
    value: statusExample('ASSIGNED', {
      mode: 'PROVIDER',
      provider: { displayName: 'Mensajería Centro' },
      driver: null,
    }),
  },
  providerAssigned: {
    summary: 'providerAssigned',
    value: statusExample('ASSIGNED', {
      mode: 'PROVIDER',
      provider: { displayName: 'Mensajería Centro' },
      driver: { displayName: 'Alex' },
    }),
  },
  independent: {
    summary: 'independent',
    value: statusExample('ASSIGNED', {
      mode: 'INDEPENDENT',
      provider: null,
      driver: { displayName: 'Alex' },
    }),
  },
  delivered: {
    summary: 'delivered',
    value: statusExample('DELIVERED', {
      mode: 'PROVIDER',
      provider: { displayName: 'Mensajería Centro' },
      driver: { displayName: 'Alex' },
    }),
  },
  identityNotConfigured: {
    summary: 'identityNotConfigured',
    value: statusExample('ASSIGNED', {
      mode: 'INDEPENDENT',
      provider: null,
      driver: null,
    }),
  },
  historicalDelivery: {
    summary: 'historicalDelivery',
    value: statusExample('DELIVERED', {
      mode: 'PROVIDER',
      provider: null,
      driver: null,
    }),
  },
};
