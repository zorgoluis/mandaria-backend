import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.dto.js';
import {
  PROVIDER_END_REASONS,
  REASON_DETAIL_MAX,
  REASON_DETAIL_MIN,
} from './assignment-policy.js';
import type { ProviderEndReason } from './assignment-policy.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const providerIdOption = {
  format: 'uuid',
  description:
    'Proveedor que actúa, autorizado por membership. Puede omitirse sólo con exactamente una membership; nunca concede acceso por sí mismo.',
} as const;
const driverProperty = {
  format: 'uuid',
  description:
    'Driver del proveedor dueño del claim: ACTIVE, con cuenta activa y sin otra asignación de entrega ACTIVE. Un Driver de otro proveedor responde 404.',
} as const;
const vehicleProperty = {
  format: 'uuid',
  description:
    'Vehicle del mismo proveedor: ACTIVE y sin otra asignación de entrega ACTIVE. Debe respetar el emparejamiento Driver↔Vehicle de V1.4.',
} as const;

export class ProviderScopeDto {
  @ApiPropertyOptional(providerIdOption)
  @ValidateIf((_o, v) => v !== undefined)
  @IsUUID()
  providerId?: string;
}
export class ProviderScopedPageDto extends PaginationQueryDto {
  @ApiPropertyOptional(providerIdOption)
  @ValidateIf((_o, v) => v !== undefined)
  @IsUUID()
  providerId?: string;
}

export class CreateDeliveryAssignmentDto {
  @ApiProperty(driverProperty)
  @IsUUID()
  driverId!: string;
  @ApiProperty(vehicleProperty)
  @IsUUID()
  vehicleId!: string;
}

class EndReasonDto {
  @ApiProperty({
    enum: PROVIDER_END_REASONS,
    description:
      'Motivo operativo. DELIVERY_CANCELLED está reservado a la cancelación oficial del servicio.',
  })
  @IsIn(PROVIDER_END_REASONS)
  reason!: ProviderEndReason;
  @ApiPropertyOptional({
    minLength: REASON_DETAIL_MIN,
    maxLength: REASON_DETAIL_MAX,
    description: `Detalle opcional (${REASON_DETAIL_MIN}-${REASON_DETAIL_MAX} caracteres), obligatorio con OTHER. Se guarda en el historial: no incluir datos personales.`,
  })
  @Transform(trim)
  @ValidateIf((o: EndReasonDto, v) => v !== undefined || o.reason === 'OTHER')
  @IsString()
  @MinLength(REASON_DETAIL_MIN)
  @MaxLength(REASON_DETAIL_MAX)
  reasonDetail?: string;
}

export class ReassignDeliveryAssignmentDto extends EndReasonDto {
  @ApiProperty(driverProperty)
  @IsUUID()
  driverId!: string;
  @ApiProperty(vehicleProperty)
  @IsUUID()
  vehicleId!: string;
}
export class CancelDeliveryAssignmentDto extends EndReasonDto {}
