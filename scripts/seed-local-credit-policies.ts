// LOCAL/TEST ONLY. Usage: npm run db:seed:local-credit-policies
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { assertLocalDatabaseAllowed } from './local-provider-admins.js';
import { seedLocalCreditPolicies } from './local-credit-policies.js';

const prisma = new PrismaClient();
try {
  assertLocalDatabaseAllowed(process.env, 'Local credit policy seed');
  const result = await seedLocalCreditPolicies(
    prisma,
    process.env.BOOTSTRAP_ADMIN_EMAIL,
  );
  console.log(
    'LOCAL/TEST ONLY LOCAL_DELIVERY credit policies (PER_KM, 1 credit/km, minimum 3) ready',
  );
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(
    error instanceof Error && !('code' in error)
      ? error.message
      : 'Local credit policy seed failed',
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
