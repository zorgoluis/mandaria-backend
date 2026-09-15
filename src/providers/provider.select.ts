export const providerSelect = {
  id: true,
  name: true,
  code: true,
  type: true,
  status: true,
  maxDrivers: true,
  maxVehicles: true,
  createdAt: true,
  updatedAt: true,
} as const;
export const providerUsageSelect = {
  ...providerSelect,
  _count: { select: { drivers: true, vehicles: true } },
} as const;
export const memberSelect = {
  id: true,
  providerId: true,
  userId: true,
  role: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true, email: true, role: true, active: true } },
} as const;
