// LOCAL/TEST ONLY. Usage: npm run db:seed:local-driver-users
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { assertLocalSeedAllowed } from './local-provider-admins.js';
import { seedLocalDriverUsers } from './local-driver-users.js';

const prisma = new PrismaClient();
try {
  // Same guard and shared LOCAL_PROVIDER_ADMIN_PASSWORD as the provider admin seed.
  const password = assertLocalSeedAllowed(process.env);
  const users = await seedLocalDriverUsers(prisma, password);
  console.log(
    'LOCAL/TEST ONLY DRIVER users ready (no Driver profiles created)',
  );
  console.table(
    Object.entries(users).map(([name, user]) => ({ name, ...user })),
  );
} catch (error) {
  console.error(
    error instanceof Error && !('code' in error)
      ? error.message
      : 'Local DRIVER seed failed',
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
