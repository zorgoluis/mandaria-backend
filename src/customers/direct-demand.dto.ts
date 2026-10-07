import { PayerContactDto } from './payer-contact.dto.js';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Equals,
  IsDefined,
  IsOptional,
  Matches,
  ValidateNested,
} from 'class-validator';
import { CreateDeliveryRequestDto } from '../delivery-requests/delivery-requests.dto.js';
import { CustomerAuthorizationDto } from '../delivery-quotes/authorized-acceptance.dto.js';
import {
  CreatePrequoteDto,
  PrequoteResponse,
} from '../delivery-prequotes/prequotes.dto.js';
import { PrequotePackage } from '../delivery-prequotes/prequote-conditions.js';
import { PrequoteConversionResponse } from '../delivery-prequotes/prequote-conversion.dto.js';
import { DeliveryQuoteResponse } from '../delivery-quotes/delivery-quotes.responses.js';

/** Documentation only; canonical runtime normalizer validates this complete object. */
export class DirectPrequoteConditionsDto extends CreatePrequoteDto {
  @ApiProperty({
    type: [PrequotePackage],
    minItems: 1,
    maxItems: 50,
    description:
      'Categorías soportadas por las tarifas comunes; no limitado a FOOD.',
  })
  declare packages: PrequotePackage[];
}
export class DirectPrequoteDto {
  @ApiProperty({ type: DirectPrequoteConditionsDto })
  conditions!: DirectPrequoteConditionsDto;
  @ApiPropertyOptional({
    enum: ['REQUESTER', 'RECIPIENT'],
    default: 'REQUESTER',
    description: 'PERSONAL sólo REQUESTER; BUSINESS permite RECIPIENT.',
  })
  shippingPayer?: string;
}
export class DirectPrequoteResponse extends PrequoteResponse {
  @ApiProperty({ type: DirectPrequoteConditionsDto })
  declare conditions: DirectPrequoteConditionsDto;
}
export class DirectPrequoteCreatedResponse {
  @ApiProperty({ type: DirectPrequoteResponse })
  prequote!: DirectPrequoteResponse;
  @ApiProperty() replayed!: boolean;
}
export class DirectConversionResponse {
  @ApiProperty({ type: PrequoteConversionResponse })
  result!: PrequoteConversionResponse;
  @ApiProperty() replayed!: boolean;
}
export class DirectAcceptedResponse {
  @ApiProperty({ type: DeliveryQuoteResponse }) quote!: DeliveryQuoteResponse;
  @ApiProperty() replayed!: boolean;
}

export class DirectConversionDto {
  @ApiProperty({ enum: [1] }) @Equals(1) conditionsVersion!: number;
  @ApiProperty({ type: CreateDeliveryRequestDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => CreateDeliveryRequestDto)
  deliveryRequest!: CreateDeliveryRequestDto;
  @ApiPropertyOptional({ type: PayerContactDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PayerContactDto)
  payerContact?: PayerContactDto;
}
export class DirectAuthorizationDto extends CustomerAuthorizationDto {
  @ApiProperty({ enum: [1] }) @Equals(1) declare shippingTermsVersion: number;
  @ApiProperty({ pattern: '^[a-f0-9]{64}$' })
  @Matches(/^[a-f0-9]{64}$/)
  declare shippingTermsHash: string;
}
export class DirectAcceptanceDto {
  @ApiProperty({ type: DirectAuthorizationDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => DirectAuthorizationDto)
  customerAuthorization!: DirectAuthorizationDto;
}
