// LOCAL/TEST ONLY. Usage: npm run db:seed:local-provider-admins
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  assertLocalSeedAllowed,
  seedLocalProviderAdmins,
} from './local-provider-admins.js';

const prisma = new PrismaClient();
try {
  const password = assertLocalSeedAllowed(process.env);
  const result = await seedLocalProviderAdmins(prisma, {
    password,
    limits: {
      maxDrivers: Number(process.env.DEFAULT_FLEET_MAX_DRIVERS || 10),
      maxVehicles: Number(process.env.DEFAULT_FLEET_MAX_VEHICLES || 10),
    },
  });
  // IDs and emails only; the password is never printed.
  console.log('LOCAL/TEST ONLY PROVIDER_ADMIN scenario ready');
  console.table([
    { account: 'Provider A', ...result.providerA },
    { account: 'Provider B', ...result.providerB },
    { account: 'Admin A → Provider A (OWNER)', ...result.adminA },
    { account: 'Admin B → Provider B (OWNER)', ...result.adminB },
    { account: 'Admin sin membership', ...result.noMembership },
  ]);
} catch (error) {
  console.error(
    error instanceof Error && !('code' in error)
      ? error.message
      : 'Local PROVIDER_ADMIN seed failed',
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
