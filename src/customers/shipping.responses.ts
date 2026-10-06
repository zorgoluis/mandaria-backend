import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PayerContactDto } from './payer-contact.dto.js';

export class ShippingTermsResponse {
  @ApiProperty({ enum: ['REQUESTER', 'RECIPIENT'] }) payer!: string;
  @ApiProperty({ enum: ['CASH'] }) method!: string;
  @ApiProperty({ enum: ['PICKUP', 'DELIVERY'] }) dueAt!: string;
  @ApiProperty({ enum: ['DELIVERY_FEE'] }) component!: string;
  @ApiProperty({ enum: [1] }) termsVersion!: number;
  @ApiProperty({
    pattern: '^[a-f0-9]{64}$',
    description:
      'Hash inmutable de términos exactos; enviar en el consentimiento de MQ. No es una credencial.',
  })
  termsHash!: string;
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description:
      'Revisión de política congelada; no ordena fotografías públicas.',
  })
  policyRevision?: number | null;
}
export class OwnedShippingTermsResponse extends ShippingTermsResponse {
  @ApiProperty({
    type: PayerContactDto,
    nullable: true,
    description:
      'Contacto de pago propio; no se publica en status ni webhooks.',
  })
  payerContact!: PayerContactDto | null;
}
export class ShippingPaymentResponse extends ShippingTermsResponse {
  @ApiProperty({
    type: String,
    nullable: true,
    example: '55.00',
    description: 'Importe de MQ aceptada; null si todavía no fue aceptada.',
  })
  amount!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'MXN' }) currency!:
    string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) quotePublicId?:
    string | null;
  @ApiProperty({
    enum: ['CURRENT', 'HISTORICAL', 'OFFER'],
    description:
      'HISTORICAL nunca autoriza cobrar. OFFER informa términos antes de adjudicación.',
  })
  instructionStatus!: string;
  @ApiProperty({
    enum: ['DECLARED', 'NOT_DECLARED'],
    description:
      'Declaración humana de efectivo REQUESTER, no verificación bancaria ni liquidación. RECIPIENT conserva el cierre existente sin declaración añadida.',
  })
  evidenceStatus!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  declaredAt!: string | null;
  @ApiProperty({
    description:
      'Instrucción pendiente, no permiso operativo. El Driver debe seguir allowedActions y su asignación vigente; nunca cobrar de nuevo por replay.',
  })
  collectShipping!: boolean;
}
