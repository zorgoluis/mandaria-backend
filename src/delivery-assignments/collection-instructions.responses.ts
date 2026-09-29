import { ApiProperty } from '@nestjs/swagger';

class CollectionDeliveryFeeResponse {
  @ApiProperty({
    example: '25.00',
    description:
      'Importe exacto de la MQ aceptada; decimal con dos posiciones. Nunca incluye comida o créditos.',
  })
  amount!: string;
  @ApiProperty({ example: 'MXN', description: 'Moneda de la MQ aceptada.' })
  currency!: string;
}
export const collectionInstructionsDoc =
  'Sólo presente en conversiones PREPAID autorizadas. Instrucción persistida, no recibo ni confirmación de cobro. OFFER: condiciones para decidir, no ejecutar un cobro. CURRENT: ejecutor vigente, cobrar sólo al entregar. HISTORICAL: referencia sin acción de cobro (cancelación, entrega o asignación terminada). Tras entrega no inferir que se cobró. Ausente en legacy: conservar su contrato, no inferir estas reglas. Reconsultar estado antes de actuar; ninguna respuesta garantiza vigencia futura.';
export class CollectionInstructionsResponse {
  @ApiProperty({
    enum: ['OFFER', 'CURRENT', 'HISTORICAL'],
    description: collectionInstructionsDoc,
  })
  applicability!: string;
  @ApiProperty({
    enum: [true],
    description:
      'Comida pagada al restaurante según la declaración persistida del integrador. Mandaria no verifica el banco.',
  })
  goodsPaidToRestaurant!: boolean;
  @ApiProperty({
    enum: [false],
    description: 'No adelantar dinero al restaurante.',
  })
  advanceToRestaurant!: boolean;
  @ApiProperty({
    enum: [false],
    description: 'No cobrar comida al destinatario.',
  })
  collectGoodsFromRecipient!: boolean;
  @ApiProperty({ type: CollectionDeliveryFeeResponse })
  deliveryFee!: CollectionDeliveryFeeResponse;
  @ApiProperty({ enum: ['RECIPIENT'] }) payer!: string;
  @ApiProperty({ enum: ['CASH'] }) method!: string;
  @ApiProperty({ enum: ['DELIVERY'] }) dueAt!: string;
  @ApiProperty({
    enum: ['DELIVERY_FEE'],
    description:
      'Cobro exclusivo del envío; nunca del valor de comida ni de créditos del ejecutor.',
  })
  component!: string;
}
