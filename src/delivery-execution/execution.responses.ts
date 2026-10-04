import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiResponse } from '@nestjs/swagger';
import { EXECUTION_PHASES } from './execution.types.js';
import { PaginationResponse } from '../providers/providers.responses.js';
import { ResolveCustodyIncidentDto } from './execution.dto.js';

export class ExecutionResponse {
  @ApiProperty({ enum: ['DETAILED'] }) trackingMode!: string;
  @ApiProperty({ minimum: 1 }) revision!: number;
  @ApiProperty({ enum: EXECUTION_PHASES, nullable: true }) phase!:
    string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  activeAssignmentId!: string | null;
  @ApiProperty({ enum: ['NOT_COLLECTED', 'HELD', 'RETURNED', 'DELIVERED'] })
  custodyStatus!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  openIncidentId!: string | null;
  @ApiProperty({
    type: [String],
    description:
      'Acciones autorizadas para esta superficie; no acredita cobro. Revalidar siempre en servidor.',
  })
  allowedActions!: string[];
  @ApiProperty({ format: 'date-time' }) lastRecordedAt!: string;
}
export class ProviderAdvanceAttemptResponse {
  @ApiProperty({ enum: ['APPLIED', 'PENDING_OR_UNKNOWN', 'CLOSED_NO_EFFECTS'] })
  state!: string;
  @ApiProperty({ type: Number, nullable: true }) appliedRevision!:
    number | null;
  @ApiProperty({
    enum: [false],
    description:
      'El permiso de avance del administrador fue retirado; nunca autoriza otro avance.',
  })
  canStartNewAttempt!: boolean;
}
export class IncidentCreatedResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: ExecutionResponse }) execution!: ExecutionResponse;
}
export class ResolutionResponse extends IncidentCreatedResponse {
  @ApiProperty({ enum: ['RETURN_TO_ORIGIN', 'TRANSFER'] }) type!: string;
  @ApiProperty({
    format: 'date-time',
    description:
      'Fecha física declarada por SUPER_ADMIN; no es evidencia de pago.',
  })
  occurredAt!: string;
  @ApiProperty({ format: 'date-time' }) recordedAt!: string;
  @ApiProperty({ format: 'uuid' }) fromAssignmentId!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  toAssignmentId!: string | null;
}

export class ExecutionEventResponse {
  @ApiProperty({
    enum: [
      'ASSIGNED',
      'ADVANCED',
      'INCIDENT',
      'TRANSFER',
      'RETURN',
      'DELIVERED',
      'ENDED',
    ],
  })
  kind!: string;
  @ApiProperty({
    minimum: 0,
    maximum: 5,
    description:
      '0 sin hito; 1..5 siguen el orden de phase en ExecutionResponse.',
  })
  phase!: number;
  @ApiProperty() revision!: number;
  @ApiProperty({ format: 'uuid' }) assignmentId!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) actorUserId!:
    string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Rol histórico del registrador; null en cierre B2B/sistema sin suplantación humana.',
  })
  actorRole!: string | null;
  @ApiProperty({
    enum: [
      'PHONE_REPORT',
      'SELF_REPORT',
      'ADMIN_RESOLUTION',
      'SYSTEM_CANCELLATION',
    ],
  })
  source!: string;
  @ApiProperty({ format: 'date-time' }) recordedAt!: string;
}
export class ExecutionEventPage extends PaginationResponse {
  @ApiProperty({ type: [ExecutionEventResponse] })
  items!: ExecutionEventResponse[];
}
export class ExecutionDetailResponse {
  @ApiProperty({ type: ExecutionResponse }) execution!: ExecutionResponse;
  @ApiProperty({ type: ExecutionEventPage }) events!: ExecutionEventPage;
}
export class IncidentSummaryResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) dispatchId!: string;
  @ApiProperty({ format: 'date-time' }) reportedAt!: string;
  @ApiProperty() reasonCode!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  resolvedAt!: string | null;
}
export class IncidentPageResponse extends PaginationResponse {
  @ApiProperty({ type: [IncidentSummaryResponse] })
  items!: IncidentSummaryResponse[];
}
export class IncidentRecordResponse extends IncidentSummaryResponse {
  @ApiProperty({ format: 'uuid' }) assignmentId!: string;
  @ApiProperty({ format: 'uuid' }) chainId!: string;
  @ApiProperty({ format: 'uuid' }) reportedByUserId!: string;
  @ApiProperty({ maxLength: 500 }) reasonDetail!: string;
}
export class ResolutionAuditResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) incidentId!: string;
  @ApiProperty({ format: 'uuid' }) dispatchId!: string;
  @ApiProperty({ format: 'uuid' }) fromAssignmentId!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  toAssignmentId!: string | null;
  @ApiProperty({ enum: ['RETURN_TO_ORIGIN', 'TRANSFER'] }) type!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ format: 'uuid' }) actorUserId!: string;
  @ApiProperty({ format: 'date-time' }) occurredAt!: string;
  @ApiProperty({ format: 'date-time' }) recordedAt!: string;
  @ApiProperty({
    type: ResolveCustodyIncidentDto,
    description: 'Atestación privada inmutable; nunca publicar en B2B.',
  })
  confirmations!: ResolveCustodyIncidentDto;
}
export class IncidentDetailResponse {
  @ApiProperty({ type: IncidentRecordResponse })
  incident!: IncidentRecordResponse;
  @ApiProperty({ type: ResolutionAuditResponse, nullable: true })
  resolution!: ResolutionAuditResponse | null;
}
export class TransferCandidateResponse {
  @ApiProperty({ format: 'uuid' }) driverId!: string;
  @ApiProperty() driverName!: string;
  @ApiProperty({ format: 'uuid' }) vehicleId!: string;
  @ApiProperty() vehicleIdentifier!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) providerId!:
    string | null;
  @ApiProperty({ enum: ['FLEET', 'INDEPENDENT'] }) mode!: string;
}
export class TransferCandidatePageResponse extends PaginationResponse {
  @ApiProperty({ type: [TransferCandidateResponse] })
  items!: TransferCandidateResponse[];
}
export function ExecutionContract(kind: 'advance' | 'report' | 'resolve') {
  return applyDecorators(
    ApiResponse({
      status: kind === 'report' ? 201 : 200,
      type:
        kind === 'advance'
          ? ExecutionResponse
          : kind === 'report'
            ? IncidentCreatedResponse
            : ResolutionResponse,
    }),
    ApiResponse({
      status: 400,
      description:
        'VALIDATION_ERROR: UUID, revisión, campos o confirmaciones inválidos.',
    }),
    ApiResponse({
      status: 401,
      description: 'Autenticación humana requerida.',
    }),
    ApiResponse({
      status: 403,
      description: 'Rol o membership no autorizado.',
    }),
    ApiResponse({ status: 404, description: 'Recurso inexistente o ajeno.' }),
    ApiResponse({
      status: 409,
      description:
        'Sin efectos parciales: EXECUTION_CONFLICT, EXECUTION_TRANSITION_INVALID, CUSTODY_INCIDENT_REQUIRED, CUSTODY_INCIDENT_OPEN, INCIDENT_ALREADY_OPEN, INCIDENT_ALREADY_RESOLVED, CUSTODY_RECIPIENT_NOT_ELIGIBLE, IDEMPOTENCY_KEY_REUSED, EXECUTION_ATTEMPT_CLOSED. Consultar estado ante respuesta incierta; una clave cerrada nunca vuelve a aplicar efectos.',
    }),
  );
}
export class ResolutionAttemptResponse {
  @ApiProperty({ enum: ['APPLIED', 'PENDING_OR_UNKNOWN', 'CLOSED_NO_EFFECTS'] })
  state!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  resolutionId!: string | null;
  @ApiProperty({
    description:
      'Sólo true si la clave quedó cerrada sin efectos y la incidencia seguía abierta al consultar; revalidar estado antes de otra resolución.',
  })
  canStartNewAttempt!: boolean;
}

export class DriverAttemptResponse {
  @ApiProperty({ enum: ['APPLIED', 'PENDING_OR_UNKNOWN', 'CLOSED_NO_EFFECTS'] })
  state!: string;
  @ApiProperty({ format: 'uuid' }) assignmentId!: string;
  @ApiProperty({ enum: ['ADVANCE', 'REPORT', 'DELIVER'] }) operation!: string;
  @ApiProperty({
    description:
      'La clave está cerrada sin efectos y esta asignación seguía ACTIVE; no reserva el servicio ni ordena repetir acciones físicas.',
  })
  canStartNewAttempt!: boolean;
}
export class DriverCompletionResponse {
  @ApiProperty({ format: 'uuid' }) assignmentId!: string;
  @ApiProperty({ enum: ['DELIVERED'] }) status!: string;
  @ApiProperty({ format: 'date-time' }) deliveredAt!: string;
}
