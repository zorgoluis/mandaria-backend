import { activeAssignment } from '../assignments/assignment.select.js';

export const driverSelect = {
  id: true,
  providerId: true,
  userId: true,
  name: true,
  status: true,
  availability: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true, email: true, role: true, active: true } },
  assignments: {
    ...activeAssignment,
    select: {
      id: true,
      assignedAt: true,
      vehicle: {
        select: { id: true, identifier: true, type: true, status: true },
      },
    },
  },
} as const;
export const driverSelfSelect = {
  id: true,
  name: true,
  status: true,
  availability: true,
  provider: {
    select: { id: true, name: true, code: true, type: true, status: true },
  },
  assignments: {
    ...activeAssignment,
    select: {
      id: true,
      assignedAt: true,
      vehicle: {
        select: {
          id: true,
          identifier: true,
          type: true,
          status: true,
          brand: true,
          model: true,
          year: true,
          color: true,
          plate: true,
        },
      },
    },
  },
} as const;
