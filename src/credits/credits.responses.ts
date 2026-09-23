import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CreditAccountOwnerType,
  CreditLedgerEntryType,
  CreditRechargeMethod,
} from '@prisma/client';
import { PaginationResponse } from '../providers/providers.responses.js';
import { MAX_CREDIT_BALANCE } from './credit-policy.js';

const creditsDoc =
  'Créditos Mandaria enteros: el derecho comercial a adjudicarse servicios. No son dinero — no son la tarifa del envío, ni el valor de la mercancía, ni efectivo del repartidor — y por eso no llevan moneda ni decimales.';

// Every nullable property declares `type` explicitly: a TypeScript union such as `string | null`
// reflects as Object, which OpenAPI would publish as an ambiguous bare `type: object`.

export class CreditAccountResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    enum: CreditAccountOwnerType,
    description:
      'PROVIDER: la cuenta única del proveedor, que usan todos sus Drivers de flotilla. INDEPENDENT_DRIVER: la cuenta propia de un repartidor independiente.',
  })
  ownerType!: CreditAccountOwnerType;
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Presente sólo con ownerType PROVIDER.',
  })
  providerId!: string | null;
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Presente sólo con ownerType INDEPENDENT_DRIVER.',
  })
  independentDriverProfileId!: string | null;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: MAX_CREDIT_BALANCE,
    example: 500,
    description: `Saldo en créditos (entero, nunca negativo). ${creditsDoc}`,
  })
  balance!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
}

export class CreditLedgerEntryResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    type: 'integer',
    description:
      'Orden real de aplicación. Los movimientos de una cuenta se serializan con el bloqueo de su fila, así que ordenar por sequence reproduce su historia exacta.',
  })
  sequence!: number;
  @ApiProperty({
    enum: CreditLedgerEntryType,
    description:
      'RECHARGE y ADMIN_ADJUSTMENT son los únicos que produce V1.10-A. SERVICE_AWARD y SERVICE_REFUND quedan reservados para el cobro por servicio (versiones posteriores): hoy CLAIM y TAKE no consumen créditos.',
  })
  type!: CreditLedgerEntryType;
  @ApiProperty({
    type: 'integer',
    example: 500,
    description:
      'Créditos con signo: positivo suma, negativo resta. Nunca 0. RECHARGE y SERVICE_REFUND siempre suman; SERVICE_AWARD siempre resta.',
  })
  amount!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) balanceBefore!: number;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Siempre balanceBefore + amount.',
  })
  balanceAfter!: number;
  @ApiPropertyOptional({
    enum: CreditRechargeMethod,
    nullable: true,
    description: 'Sólo en RECHARGE.',
  })
  rechargeMethod!: CreditRechargeMethod | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Sólo en RECHARGE: folio o referencia externa del pago.',
  })
  externalReference!: string | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Motivo. Siempre presente en ADMIN_ADJUSTMENT y en RECHARGE con OTHER.',
  })
  reason!: string | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: null,
    description:
      'Reservado para SERVICE_AWARD/SERVICE_REFUND (p. ej. DISPATCH). Siempre null en V1.10-A.',
  })
  referenceType!: string | null;
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
  })
  referenceId!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
}
export class CreditLedgerPageResponse extends PaginationResponse {
  @ApiProperty({ type: CreditLedgerEntryResponse, isArray: true })
  items!: CreditLedgerEntryResponse[];
}

/** SUPER_ADMIN only: adds who acted and with which Idempotency-Key. */
export class AdminCreditLedgerEntryResponse extends CreditLedgerEntryResponse {
  @ApiProperty({ format: 'uuid' }) creditAccountId!: string;
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'SUPER_ADMIN que registró el movimiento.',
  })
  createdByUserId!: string | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Idempotency-Key con la que se registró el movimiento.',
  })
  idempotencyKey!: string | null;
}
export class AdminCreditLedgerPageResponse extends PaginationResponse {
  @ApiProperty({ type: AdminCreditLedgerEntryResponse, isArray: true })
  items!: AdminCreditLedgerEntryResponse[];
}

export class CreditMovementResponse {
  @ApiProperty({
    type: CreditAccountResponse,
    description: 'La cuenta con el saldo ya aplicado.',
  })
  account!: CreditAccountResponse;
  @ApiProperty({
    type: AdminCreditLedgerEntryResponse,
    description:
      'El movimiento registrado. En una repetición idempotente, el original.',
  })
  entry!: AdminCreditLedgerEntryResponse;
}
