// LOCAL/TEST ONLY. Usage: npm run db:seed:local-pricing
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { assertLocalDatabaseAllowed } from './local-provider-admins.js';
import { seedLocalPricing } from './local-pricing.js';

const prisma = new PrismaClient();
try {
  assertLocalDatabaseAllowed(process.env, 'Local pricing seed');
  const result = await seedLocalPricing(prisma);
  console.log(
    'LOCAL/TEST ONLY service zones and placeholder LOCAL_DELIVERY tariff ready',
  );
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(
    error instanceof Error && !('code' in error)
      ? error.message
      : 'Local pricing seed failed',
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
