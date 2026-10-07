import {
  ApiProperty,
  ApiPropertyOptional,
  ApiExtraModels,
  getSchemaPath,
} from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
export class CustomerAttemptQuery {
  @ApiProperty({
    enum: ['PREQUOTE_CREATE', 'PREQUOTE_CONVERT', 'QUOTE_ACCEPT'],
  })
  @IsIn(['PREQUOTE_CREATE', 'PREQUOTE_CONVERT', 'QUOTE_ACCEPT'])
  operation!: 'PREQUOTE_CREATE' | 'PREQUOTE_CONVERT' | 'QUOTE_ACCEPT';
  @ApiPropertyOptional({
    description:
      'Omitir en PREQUOTE_CREATE; MPQ original para conversión, MQ original para aceptación.',
  })
  @IsOptional()
  @Matches(/^(MPQ|MQ)-[0-9]+$/)
  resourcePublicId?: string;
}
export class RecoveredShippingTerms {
  @ApiProperty({ enum: ['REQUESTER', 'RECIPIENT'] }) payer!: string;
  @ApiProperty({ enum: ['CASH'] }) method!: string;
  @ApiProperty({ enum: ['PICKUP', 'DELIVERY'] }) dueAt!: string;
  @ApiProperty({ enum: ['DELIVERY_FEE'] }) component!: string;
  @ApiProperty() termsVersion!: number;
  @ApiProperty() termsHash!: string;
  @ApiPropertyOptional({ description: 'Sólo snapshot preliminar de MPQ.' })
  policyRevision?: number;
}
export class RecoveredPrequote {
  @ApiProperty() prequotePublicId!: string;
  @ApiProperty({ example: '25.00' }) amount!: string;
  @ApiProperty({ example: 'MXN' }) currency!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ type: RecoveredShippingTerms, nullable: true })
  shippingTerms!: RecoveredShippingTerms | null;
}
export class RecoveredConversion extends RecoveredPrequote {
  @ApiProperty() deliveryRequestPublicId!: string;
  @ApiProperty() deliveryQuotePublicId!: string;
}
export class RecoveredAcceptance {
  @ApiProperty() deliveryRequestPublicId!: string;
  @ApiProperty() deliveryQuotePublicId!: string;
  @ApiProperty({ example: '25.00' }) amount!: string;
  @ApiProperty({ example: 'MXN' }) currency!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ format: 'date-time' }) acceptedAt!: string;
  @ApiProperty({ type: RecoveredShippingTerms, nullable: true })
  shippingTerms!: RecoveredShippingTerms | null;
}
export class RecoveredPolicy {
  @ApiProperty({ enum: ['REQUESTER', 'RECIPIENT'] }) payer!: string;
  @ApiProperty({ minimum: 1 }) revision!: number;
}
export class ConsentPrequote {
  @ApiProperty() publicId!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}
export class ConsentQuote extends ConsentPrequote {
  @ApiProperty({ example: '25.00' }) amount!: string;
  @ApiProperty({ example: 'MXN' }) currency!: string;
  @ApiProperty({ enum: ['OFFERED', 'ACCEPTED', 'EXPIRED', 'CANCELLED'] })
  status!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  acceptedAt!: string | null;
}
export class ConsentContext {
  @ApiProperty() deliveryRequestPublicId!: string;
  @ApiProperty({ type: ConsentPrequote, nullable: true })
  prequote!: ConsentPrequote | null;
  @ApiProperty({ type: ConsentQuote, nullable: true })
  quote!: ConsentQuote | null;
  @ApiProperty({
    type: RecoveredShippingTerms,
    nullable: true,
    description:
      'Hash FINAL persistido sobre los términos de MDR/MQ; no usar el hash preliminar de MPQ para consentir.',
  })
  shippingTerms!: RecoveredShippingTerms | null;
  @ApiProperty({
    description:
      'Indicación vigente al leer; POST vuelve a validar TTL, términos y permisos.',
  })
  canPrepareConsent!: boolean;
  @ApiProperty({ enum: [false] }) automaticAcceptance!: boolean;
}
@ApiExtraModels(
  RecoveredPrequote,
  RecoveredConversion,
  RecoveredAcceptance,
  RecoveredPolicy,
)
export class HumanAttemptResult {
  @ApiProperty({
    enum: [
      'PREQUOTE_CREATE',
      'PREQUOTE_CONVERT',
      'QUOTE_ACCEPT',
      'SHIPPING_POLICY',
    ],
  })
  operation!: string;
  @ApiProperty({ type: String, nullable: true }) resourcePublicId!:
    string | null;
  @ApiProperty({ enum: ['APPLIED', 'PENDING_OR_UNKNOWN', 'CLOSED_NO_EFFECTS'] })
  state!: string;
  @ApiProperty({
    description:
      'Permite preparar otra intención explícita, nunca enviarla automáticamente.',
  })
  canPrepareNewAttempt!: boolean;
  @ApiProperty({
    enum: ['RESOURCE_OR_POLICY_ONLY'],
    description:
      'Cierre impide publicación/commit del comando. No deshace routing ni presupuesto ya autorizado.',
  })
  closureScope!: string;
  @ApiProperty({
    enum: ['NONE_STARTED', 'POSSIBLE_RETAINED'],
    description:
      'POSSIBLE_RETAINED: routing autorizado/incierto puede terminar incluso tras el cierre; consumo se conserva, no se devuelve presupuesto.',
  })
  routingEffects!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  closedAt!: string | null;
  @ApiProperty({
    nullable: true,
    anyOf: [
      RecoveredPrequote,
      RecoveredConversion,
      RecoveredAcceptance,
      RecoveredPolicy,
    ].map((t) => ({ $ref: getSchemaPath(t) })),
    description:
      'APPLIED: seleccionar forma por operation. Resto: null. Resultado original sin cuerpo, contacto ni consentimiento; no implica vigencia actual.',
  })
  result!: Record<string, unknown> | null;
}
