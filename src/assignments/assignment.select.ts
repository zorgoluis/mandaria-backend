export const activeAssignment = {
  where: { unassignedAt: null },
  take: 1,
} as const;
export const assignmentHistorySelect = {
  id: true,
  providerId: true,
  driverId: true,
  vehicleId: true,
  assignedAt: true,
  unassignedAt: true,
  driver: { select: { id: true, name: true } },
  vehicle: { select: { id: true, identifier: true, type: true } },
} as const;
/** Replaces the one-element assignments relation with currentAssignment (or null). */
export function withCurrentAssignment<T extends { assignments: unknown[] }>(
  row: T,
) {
  const { assignments, ...rest } = row;
  return {
    ...rest,
    currentAssignment: (assignments[0] ?? null) as
      T['assignments'][number] | null,
  };
}
