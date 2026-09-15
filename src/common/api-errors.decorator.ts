import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

const descriptions: Record<number, string> = {
  400: 'Validación fallida: UUID, campos, límites o consulta inválidos. No se aceptan campos desconocidos.',
  401: 'Se requiere access JWT humano válido; un token B2B no es válido aquí.',
  403: 'Rol global insuficiente o falta membership del proveedor solicitado.',
  404: 'Proveedor, usuario, membership, Driver, Vehicle o asignación no encontrado. Recursos de otro proveedor se reportan como no encontrados.',
  409: 'Conflicto: duplicado, transición inválida, usuario no elegible, límite maxDrivers/maxVehicles alcanzado, Driver/Vehicle no elegible u ocupado, o selección de proveedor ambigua.',
  429: 'Límite de peticiones por IP excedido (100/minuto).',
  500: 'Error interno sanitizado; no se exponen SQL ni credenciales.',
};
export function ApiErrors(...statuses: number[]) {
  return applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: descriptions[status],
        schema: {
          type: 'object',
          required: [
            'statusCode',
            'code',
            'message',
            'errors',
            'timestamp',
            'path',
          ],
          properties: {
            statusCode: { type: 'integer', example: status },
            code: {
              type: 'string',
              example: status === 400 ? 'VALIDATION_ERROR' : 'HTTP_' + status,
            },
            message: {
              type: 'string',
              example:
                status === 400
                  ? 'Validation failed'
                  : status === 403
                    ? 'Forbidden resource'
                    : 'Request failed',
            },
            errors: {
              type: 'array',
              items: { type: 'string' },
              example:
                status === 400 ? ['maxDrivers must not be less than 1'] : [],
            },
            timestamp: { type: 'string', format: 'date-time' },
            path: { type: 'string', example: '/api/v1/admin/providers' },
          },
        },
      }),
    ),
  );
}
