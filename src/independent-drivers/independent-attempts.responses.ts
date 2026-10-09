import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import type { IndependentOperation } from './independent-attempts.js';
export class IndependentAttemptQueryDto {
  @ApiProperty({ enum: ['TAKE', 'RELEASE'] })
  @IsIn(['TAKE', 'RELEASE'])
  operation!: IndependentOperation;
}
export class IndependentAttemptCreditsResponse {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Cargo original propio; null si adjudicación legítimamente gratuita.',
  })
  awardEntryId!: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Refund de créditos propio que compensa awardEntryId. Nunca devolución de efectivo.',
  })
  refundEntryId!: string | null;
  @ApiProperty({
    type: Number,
    description:
      'Movimiento confirmado de esta operación, en créditos enteros: TAKE negativo, RELEASE positivo, o0. No es saldo actual.',
  })
  amount!: number;
}
export class IndependentCommandResponse {
  @ApiProperty({ enum: ['TAKE', 'RELEASE'] }) operation!: IndependentOperation;
  @ApiProperty({ format: 'uuid' }) dispatchId!: string;
  @ApiProperty({ format: 'uuid' }) assignmentId!: string;
  @ApiProperty({
    enum: ['CLAIMED', 'OPEN', 'EXPIRED'],
    description:
      'Estado al confirmar el intento; no sustituye la fotografía actual.',
  })
  dispatchStatus!: string;
  @ApiProperty({ enum: ['ACTIVE', 'CANCELLED'] }) assignmentStatus!: string;
  @ApiProperty({ type: IndependentAttemptCreditsResponse })
  credits!: IndependentAttemptCreditsResponse;
}
export class IndependentAttemptResponse {
  @ApiProperty({ enum: ['TAKE', 'RELEASE'] }) operation!: IndependentOperation;
  @ApiProperty({ format: 'uuid' }) dispatchId!: string;
  @ApiProperty({ enum: ['APPLIED', 'PENDING_OR_UNKNOWN', 'CLOSED_NO_EFFECTS'] })
  state!: string;
  @ApiProperty({
    type: IndependentCommandResponse,
    nullable: true,
    description:
      'Sólo el resultado histórico del actor autenticado. Nunca datos del ejecutor actual.',
  })
  result!: IndependentCommandResponse | null;
  @ApiProperty({
    description:
      'true sólo tras cierre durable. Permite preparar, no enviar automáticamente; elegibilidad se revalida al comando.',
  })
  canPrepareNewAttempt!: boolean;
}
