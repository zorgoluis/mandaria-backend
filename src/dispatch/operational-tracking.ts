import type { Prisma } from '@prisma/client';

/** This branch only persists legacy assignments. Count ALL history, not just ACTIVE. */
export const operationalTrackingSelect = {
  _count: { select: { deliveryAssignments: true } },
} satisfies Prisma.DispatchSelect;

export function operationalTrackingMode(record: {
  _count: { deliveryAssignments: number };
}): 'LEGACY' | null {
  return record._count.deliveryAssignments > 0 ? 'LEGACY' : null;
}

export const operationalTrackingDoc =
  'Clasificación histórica de esta rama: null si nunca tuvo asignación; LEGACY si existe alguna asignación persistida, incluso finalizada. No implica permisos ni asignación activa. Esta rama no implementa DETAILED.';
