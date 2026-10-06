import type { PrismaClient } from '@prisma/client';

/** V1.17 contracts are immutable audit history. Retain synthetic histories instead of
 * weakening their DELETE guards during teardown; retire only this suite's coverage. */
export async function retainShippingFixtures(
  db: PrismaClient,
  clientIds: string[],
  zoneIds: string[] = [],
) {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '');
  if (
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    !url.pathname.endsWith('_test')
  )
    throw Error('Isolated local test DB required');
  if (!clientIds.length) return false;
  const evidence = await db.deliveryShippingTerms.findFirst({
    where: { request: { integrationClientId: { in: clientIds } } },
    select: { deliveryRequestId: true },
  });
  if (!evidence) return false;
  const quotes = await db.deliveryQuote.findMany({
    where: { deliveryRequest: { integrationClientId: { in: clientIds } } },
    select: { serviceZoneId: true },
  });
  await db.serviceZone.updateMany({
    where: { id: { in: [...zoneIds, ...quotes.map((q) => q.serviceZoneId)] } },
    data: { status: 'INACTIVE' },
  });
  return true;
}
