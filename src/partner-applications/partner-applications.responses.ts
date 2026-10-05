import { ApiProperty } from '@nestjs/swagger';
import {
  PartnerApplicationStatus,
  PartnerApplicationType,
  VehicleType,
} from '@prisma/client';
import { PaginationResponse } from '../providers/providers.responses.js';

export class PartnerApplicationReceiptResponse {
  @ApiProperty({ example: 'SOC-000123', pattern: '^SOC-[0-9]{6,}$' })
  reference!: string;
  @ApiProperty({ enum: ['RECEIVED'], example: 'RECEIVED' })
  status!: 'RECEIVED';
}

export class PartnerApplicationResponse {
  @ApiProperty({ example: 'SOC-000123' }) reference!: string;
  @ApiProperty({ enum: PartnerApplicationType }) type!: PartnerApplicationType;
  @ApiProperty({ enum: PartnerApplicationStatus })
  status!: PartnerApplicationStatus;
  @ApiProperty({ example: 'Ana López' }) contactName!: string;
  @ApiProperty({ example: '9611234567' }) phone!: string;
  @ApiProperty({ example: 'ana@example.com' }) email!: string;
  @ApiProperty({ example: 'Tuxtla Gutiérrez' }) city!: string;
  @ApiProperty({ enum: VehicleType }) vehicleType!: VehicleType;
  @ApiProperty({ type: String, nullable: true, example: null })
  fleetName!: string | null;
  @ApiProperty({ type: 'integer', nullable: true, example: null })
  fleetUnits!: number | null;
  @ApiProperty({ example: '2026-10' }) privacyNoticeVersion!: string;
  @ApiProperty({ format: 'date-time' }) privacyAcceptedAt!: Date;
  @ApiProperty({ enum: ['LANDING'] }) source!: string;
  @ApiProperty({
    type: 'integer',
    minimum: 1,
    description:
      'Envíos recibidos para esta solicitud, incluidos los duplicados absorbidos (mismo teléfono o correo, abierta, ≤ 30 días).',
  })
  submissionCount!: number;
  @ApiProperty({ format: 'date-time' }) lastSubmittedAt!: Date;
  @ApiProperty({ type: String, nullable: true }) reviewNote!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  statusChangedAt!: Date | null;
  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  statusChangedByUserId!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  providerId!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  invitationId!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
  @ApiProperty({
    description:
      'Transiciones que acepta el estado actual; vacío en REJECTED y DISCARDED.',
    enum: PartnerApplicationStatus,
    isArray: true,
  })
  allowedTransitions!: PartnerApplicationStatus[];
}

export class PartnerApplicationPageResponse extends PaginationResponse {
  @ApiProperty({ type: [PartnerApplicationResponse] })
  items!: PartnerApplicationResponse[];
}
