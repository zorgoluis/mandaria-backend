import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  DispatchStatus,
  ProviderServiceCoverageStatus,
  ServiceType,
} from '@prisma/client';
import { PaginationQueryDto } from '../common/pagination.dto.js';
import {
  DISPATCH_VIEWS,
  RELEASE_REASON_MAX,
  RELEASE_REASON_MIN,
} from './dispatch-policy.js';
import type { DispatchView } from './dispatch-policy.js';

const optional = () => ValidateIf((_o, v) => v !== undefined);
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const providerIdOption = {
  format: 'uuid',
  description:
    'Proveedor que actúa, autorizado por membership. Puede omitirse sólo con exactamente una membership; nunca concede acceso por sí mismo.',
} as const;

/** Only the provider selector: claim has no body, so the provider can never come from payload. */
export class ProviderDispatchScopeDto {
  @ApiPropertyOptional(providerIdOption)
  @optional()
  @IsUUID()
  providerId?: string;
}

/**
 * Claim takes no body. Declaring an empty DTO makes the global ValidationPipe reject any field
 * (e.g. providerId or driverId) with 400 instead of silently ignoring it.
 */
export class ClaimDispatchDto {}

/**
 * Completion takes no body either (V1.11-A): quién entrega sale del JWT y cuándo lo decide el
 * servidor. Ningún campo del cliente puede alterar la entrega, así que cualquiera se rechaza con
 * 400 en lugar de ignorarse.
 */
export class CompleteDeliveryDto {}

export class ProviderDispatchListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional(providerIdOption)
  @optional()
  @IsUUID()
  providerId?: string;
  @ApiPropertyOptional({
    enum: DISPATCH_VIEWS,
    default: 'ALL',
    description:
      'AVAILABLE: OPEN, vigente y con candidatura OFFERED de mi proveedor (reclamables). CLAIMED: reclamados actualmente por mi proveedor. ALL: todos los Dispatch en los que mi proveedor fue candidato.',
  })
  @optional()
  @IsIn(DISPATCH_VIEWS)
  view?: DispatchView;
  @ApiPropertyOptional({
    enum: DispatchStatus,
    description:
      'Estado efectivo (un OPEN vencido cuenta como EXPIRED). Se combina con view.',
  })
  @optional()
  @IsEnum(DispatchStatus)
  status?: DispatchStatus;
}

export class AdminDispatchListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: DispatchStatus,
    description: 'Estado efectivo.',
  })
  @optional()
  @IsEnum(DispatchStatus)
  status?: DispatchStatus;
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Dispatches en los que este proveedor fue candidato.',
  })
  @optional()
  @IsUUID()
  providerId?: string;
  @ApiPropertyOptional({ example: 'MDR-000001' })
  @optional()
  @IsString()
  @MaxLength(32)
  deliveryRequestPublicId?: string;
}

export class ReleaseDispatchDto {
  @ApiProperty({
    minLength: RELEASE_REASON_MIN,
    maxLength: RELEASE_REASON_MAX,
    example: 'Sin repartidor disponible en la zona',
    description: `Motivo operativo (${RELEASE_REASON_MIN}-${RELEASE_REASON_MAX} caracteres, se recortan espacios). Se conserva en la candidatura y en la auditoría: no incluir datos personales.`,
  })
  @Transform(trim)
  @IsString()
  @MinLength(RELEASE_REASON_MIN)
  @MaxLength(RELEASE_REASON_MAX)
  reason!: string;
}

export class CreateServiceCoverageDto {
  @ApiProperty({ format: 'uuid', description: 'ServiceZone existente.' })
  @IsUUID()
  serviceZoneId!: string;
  @ApiProperty({ enum: ServiceType, example: 'LOCAL_DELIVERY' })
  @IsEnum(ServiceType)
  serviceType!: ServiceType;
}

export class UpdateServiceCoverageDto {
  @ApiProperty({
    enum: ProviderServiceCoverageStatus,
    description:
      'INACTIVE deja de ofrecer nuevos Dispatch y bloquea claims pendientes de ese proveedor en esa zona/servicio.',
  })
  @IsEnum(ProviderServiceCoverageStatus)
  status!: ProviderServiceCoverageStatus;
}
