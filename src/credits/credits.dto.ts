import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotEquals,
  ValidateIf,
} from 'class-validator';
import { CreditRechargeMethod } from '@prisma/client';
import { PaginationQueryDto } from '../common/pagination.dto.js';
import {
  CREDIT_REASON_MAX,
  CREDIT_REASON_MIN,
  CREDIT_REFERENCE_MAX,
  MAX_CREDIT_MOVEMENT,
  PRINTABLE_TEXT,
} from './credit-policy.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Bodies carry no account id, owner id or ownerType: the account is always the one of the owner
 * named by the route and authorized by the guards. Unknown fields are rejected (400), so a forged
 * ownerType, balance or providerId cannot be smuggled in.
 */
export class RechargeCreditsDto {
  @ApiProperty({
    type: 'integer',
    minimum: 1,
    maximum: MAX_CREDIT_MOVEMENT,
    example: 500,
    description: `Créditos enteros a sumar (1–${MAX_CREDIT_MOVEMENT}). Son créditos Mandaria, no pesos: sin decimales ni moneda. Un número decimal, negativo, cero, en texto o mayor al límite responde 400.`,
  })
  @IsInt()
  @Min(1)
  @Max(MAX_CREDIT_MOVEMENT)
  credits!: number;
  @ApiProperty({
    enum: CreditRechargeMethod,
    description:
      'Cómo se pagó la recarga fuera de Mandaria. Es una declaración de SUPER_ADMIN, no una pasarela: Mandaria no verifica ese pago. OTHER exige reason.',
  })
  @IsEnum(CreditRechargeMethod)
  method!: CreditRechargeMethod;
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: CREDIT_REFERENCE_MAX,
    example: 'SPEI 0123456789',
    description:
      'Folio o referencia externa del pago (transferencia, recibo). Nunca datos de tarjeta ni credenciales. Sin caracteres de control.',
  })
  @Transform(trim)
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(CREDIT_REFERENCE_MAX)
  @Matches(PRINTABLE_TEXT)
  externalReference?: string;
  @ApiPropertyOptional({
    minLength: CREDIT_REASON_MIN,
    maxLength: CREDIT_REASON_MAX,
    description: `Motivo (${CREDIT_REASON_MIN}-${CREDIT_REASON_MAX} caracteres). Opcional con TRANSFER o CASH; obligatorio con OTHER. Queda en el ledger: no incluir datos personales.`,
  })
  @Transform(trim)
  @ValidateIf(
    (o: RechargeCreditsDto, v) => v !== undefined || o.method === 'OTHER',
  )
  @IsString()
  @MinLength(CREDIT_REASON_MIN)
  @MaxLength(CREDIT_REASON_MAX)
  @Matches(PRINTABLE_TEXT)
  reason?: string;
}

export class AdjustCreditsDto {
  @ApiProperty({
    type: 'integer',
    minimum: -MAX_CREDIT_MOVEMENT,
    maximum: MAX_CREDIT_MOVEMENT,
    example: -20,
    description: `Créditos enteros con signo: positivo suma, negativo resta (±1–${MAX_CREDIT_MOVEMENT}). 0 responde 400. Si el saldo quedaría negativo responde 409 INSUFFICIENT_CREDITS y no se aplica nada.`,
  })
  @IsInt()
  @Min(-MAX_CREDIT_MOVEMENT)
  @Max(MAX_CREDIT_MOVEMENT)
  @NotEquals(0)
  amount!: number;
  @ApiProperty({
    minLength: CREDIT_REASON_MIN,
    maxLength: CREDIT_REASON_MAX,
    description: `Motivo obligatorio del ajuste (${CREDIT_REASON_MIN}-${CREDIT_REASON_MAX} caracteres). Queda en el ledger y lo ve el dueño de la cuenta: no incluir datos personales.`,
  })
  @Transform(trim)
  @IsString()
  @MinLength(CREDIT_REASON_MIN)
  @MaxLength(CREDIT_REASON_MAX)
  @Matches(PRINTABLE_TEXT)
  reason!: string;
}

export class CreditLedgerQueryDto extends PaginationQueryDto {}
