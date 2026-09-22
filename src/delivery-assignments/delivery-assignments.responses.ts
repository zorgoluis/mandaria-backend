import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  DeliveryAssignmentEndReason,
  DeliveryAssignmentStatus,
  DriverAvailability,
  GoodsPaymentMode,
  VehicleType,
} from '@prisma/client';
import { PaginationResponse } from '../providers/providers.responses.js';

class AssignmentDriverResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Carlos' }) name!: string;
}
class AssignmentVehicleResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'MOTO-03' }) identifier!: string;
  @ApiProperty({ enum: VehicleType }) type!: VehicleType;
  @ApiPropertyOptional({ type: String, nullable: true, example: 'ABC-123' })
  plate!: string | null;
}
class MoneyResponse {
  @ApiProperty({ example: '60.00' }) amount!: string;
  @ApiProperty({ example: 'MXN' }) currency!: string;
}
export class PaymentContextResponse {
  @ApiProperty({
    type: MoneyResponse,
    description:
      'Precio logístico congelado de la Quote; no es dinero de la mercancía.',
  })
  deliveryFee!: MoneyResponse;
  @ApiPropertyOptional({
    type: MoneyResponse,
    nullable: true,
    description: 'Valor declarado de la mercancía (V1.5).',
  })
  goodsValue!: MoneyResponse | null;
  @ApiPropertyOptional({ enum: GoodsPaymentMode, nullable: true })
  goodsPaymentMode!: GoodsPaymentMode | null;
  @ApiProperty({
    description:
      'true con COURIER_ADVANCE: el repartidor paga la mercancía al comercio.',
  })
  driverAdvancesGoods!: boolean;
  @ApiPropertyOptional({
    type: MoneyResponse,
    nullable: true,
    description:
      'Dinero que el repartidor debe adelantar al comercio al recoger. Mandaria no mueve ese dinero ni valida saldos del repartidor: el proveedor es responsable.',
  })
  driverAdvanceAmount!: MoneyResponse | null;
}
export class DeliveryAssignmentResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) dispatchId!: string;
  @ApiProperty({ format: 'uuid' }) providerId!: string;
  @ApiProperty({
    enum: DeliveryAssignmentStatus,
    description:
      'ACTIVE: ejecuta el servicio. REASSIGNED: sustituida por otra asignación. CANCELLED: terminada sin reemplazo (liberación de recursos o cancelación del servicio).',
  })
  status!: DeliveryAssignmentStatus;
  @ApiProperty({ type: AssignmentDriverResponse })
  driver!: AssignmentDriverResponse;
  @ApiProperty({ type: AssignmentVehicleResponse })
  vehicle!: AssignmentVehicleResponse;
  @ApiProperty({ format: 'date-time' }) assignedAt!: Date;
  @ApiProperty({ format: 'uuid' }) assignedByUserId!: string;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  endedAt!: Date | null;
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  endedByUserId!: string | null;
  @ApiPropertyOptional({ enum: DeliveryAssignmentEndReason, nullable: true })
  endReason!: DeliveryAssignmentEndReason | null;
  @ApiPropertyOptional({ type: String, nullable: true }) endReasonDetail!:
    string | null;
}
export class DeliveryAssignmentWithPaymentResponse extends DeliveryAssignmentResponse {
  @ApiProperty({ type: PaymentContextResponse })
  paymentContext!: PaymentContextResponse;
}
class AvailableVehicleRefResponse extends AssignmentVehicleResponse {
  @ApiProperty({ example: 'ACTIVE' }) status!: string;
}
export class AvailableDriverResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Carlos' }) name!: string;
  @ApiProperty({
    enum: DriverAvailability,
    description:
      'Informativo. V1.8 no exige AVAILABLE ni conexión del Driver para asignar.',
  })
  availability!: DriverAvailability;
  @ApiPropertyOptional({
    type: AvailableVehicleRefResponse,
    nullable: true,
    description:
      'Vehículo emparejado en V1.4. Si existe, la asignación debe usar ese vehículo.',
  })
  pairedVehicle!: AvailableVehicleRefResponse | null;
}
export class AvailableDriverPageResponse extends PaginationResponse {
  @ApiProperty({ type: AvailableDriverResponse, isArray: true })
  items!: AvailableDriverResponse[];
}
export class AvailableVehicleResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'MOTO-03' }) identifier!: string;
  @ApiProperty({ enum: VehicleType }) type!: VehicleType;
  @ApiPropertyOptional({ type: String, nullable: true }) brand!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) model!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) color!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) plate!: string | null;
  @ApiPropertyOptional({
    type: AssignmentDriverResponse,
    nullable: true,
    description:
      'Driver emparejado en V1.4. Si existe, sólo ese Driver puede usar el vehículo.',
  })
  pairedDriver!: AssignmentDriverResponse | null;
}
export class AvailableVehiclePageResponse extends PaginationResponse {
  @ApiProperty({ type: AvailableVehicleResponse, isArray: true })
  items!: AvailableVehicleResponse[];
}
class DeliveryAssignmentProviderResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() code!: string;
}
export class AdminDeliveryAssignmentResponse extends DeliveryAssignmentResponse {
  @ApiProperty({
    type: DeliveryAssignmentProviderResponse,
    description: 'Proveedor dueño de la asignación.',
  })
  provider!: DeliveryAssignmentProviderResponse;
}
