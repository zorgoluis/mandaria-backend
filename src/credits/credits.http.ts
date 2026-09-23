import { BadRequestException, applyDecorators } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiParam,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { IDEMPOTENCY_KEY_PATTERN } from './credit-policy.js';
import { CreditMovementResponse } from './credits.responses.js';

/**
 * Credit mutations use the same Idempotency-Key contract as B2B DeliveryRequest creation, but the
 * key lives in the ledger (unique per credit account) because the actor is a human SUPER_ADMIN,
 * not an IntegrationClient. It is required: an accidental double click, browser retry or network
 * retry must never recharge twice.
 */
export function readIdempotencyKey(value: string | string[] | undefined) {
  // A repeated header arrives as an array (or comma-joined); either way it is not one key.
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value))
    throw new BadRequestException([
      'Idempotency-Key header is required (8-255 visible ASCII characters)',
    ]);
  return value;
}

export function movementStatus(res: Response, replayed: boolean) {
  res.status(replayed ? 200 : 201);
  res.setHeader('Idempotent-Replayed', String(replayed));
}

export const MovementDocs = () =>
  applyDecorators(
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      description:
        '8–255 caracteres ASCII visibles, única por cuenta de créditos. Misma key + mismo cuerpo → devuelve el movimiento original sin aplicarlo otra vez (200, Idempotent-Replayed: true). Misma key + cuerpo distinto → 409 CREDIT_IDEMPOTENCY_CONFLICT. Generar una nueva por cada operación intencional (p. ej. un UUID por clic).',
      example: '6c1f2f7e-2a0d-4c55-9a3b-7d1c9e0f4b21',
    }),
    ApiCreatedResponse({
      type: CreditMovementResponse,
      description: 'Movimiento aplicado (Idempotent-Replayed: false).',
    }),
    ApiOkResponse({
      type: CreditMovementResponse,
      description:
        'Repetición idempotente: devuelve el movimiento original y el saldo actual, sin aplicar nada (Idempotent-Replayed: true).',
    }),
  );

export const DriverParam = () =>
  ApiParam({
    name: 'driverId',
    format: 'uuid',
    description:
      'Driver.id de un repartidor independiente (misma ruta base que /admin/drivers/:driverId/independent).',
  });
export const ProviderParam = () =>
  ApiParam({ name: 'providerId', format: 'uuid' });

export const adminCreditErrors = {
  400: 'VALIDATION_ERROR: UUID, créditos no enteros, cero, negativos donde no aplica o fuera de límite, motivo inválido, Idempotency-Key ausente o inválida, o campos desconocidos (ownerType, balance, ids de cuenta).',
  401: 'Se requiere access JWT humano de un User ACTIVE; un token B2B no es válido.',
  403: 'Rol global distinto de SUPER_ADMIN. PROVIDER_ADMIN y DRIVER sólo pueden consultar su propia cuenta.',
  404: 'Dueño inexistente, o sin cuenta de créditos (CREDIT_ACCOUNT_NOT_FOUND: p. ej. un Driver de flotilla o un independiente nunca aprobado).',
  429: 'Límite de peticiones por IP excedido (100/minuto).',
  500: 'Error interno sanitizado.',
};
export const movementConflicts =
  'INSUFFICIENT_CREDITS (el saldo quedaría negativo) | CREDIT_BALANCE_LIMIT (superaría el máximo) | CREDIT_IDEMPOTENCY_CONFLICT (key reutilizada con otro cuerpo) | CREDIT_MOVEMENT_CONFLICT (carrera perdida; reintentar con la misma key). En todos los casos no se aplica nada.';
