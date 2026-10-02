export const EXECUTION_PHASES = [
  'TO_PICKUP',
  'AT_PICKUP',
  'PICKED_UP',
  'TO_DROPOFF',
  'AT_DROPOFF',
] as const;
export type ExecutionPhase = (typeof EXECUTION_PHASES)[number];
export const CUSTODY_REASONS = [
  'RECIPIENT_UNAVAILABLE',
  'DELIVERY_REFUSED',
  'VEHICLE_FAILURE',
  'SAFETY_CONCERN',
  'OTHER',
] as const;

export type ExecutionView = {
  trackingMode: 'DETAILED';
  revision: number;
  phase: ExecutionPhase | null;
  activeAssignmentId: string | null;
  custodyStatus: 'NOT_COLLECTED' | 'HELD' | 'RETURNED' | 'DELIVERED';
  openIncidentId: string | null;
  allowedActions: string[];
  lastRecordedAt: string;
};
