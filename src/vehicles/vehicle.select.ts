import { activeAssignment } from '../assignments/assignment.select.js';

export const vehicleSelect = {
  id: true,
  providerId: true,
  identifier: true,
  type: true,
  status: true,
  brand: true,
  model: true,
  year: true,
  color: true,
  plate: true,
  createdAt: true,
  updatedAt: true,
  assignments: {
    ...activeAssignment,
    select: {
      id: true,
      assignedAt: true,
      driver: {
        select: { id: true, name: true, status: true, availability: true },
      },
    },
  },
} as const;
