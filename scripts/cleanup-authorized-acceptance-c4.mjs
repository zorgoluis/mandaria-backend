import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { readFileSync, writeFileSync } from 'node:fs';
const source = new URL(process.env.TEST_DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(source.hostname))
  throw Error('Local only');
const state = JSON.parse(readFileSync('.tmp/c4/databases.json'));
const reg = JSON.parse(readFileSync('docs/checks/v1.13-c4-regression.json'));
const names = [
  ...new Set([...Object.values(state), ...reg.attempts.map((a) => a.database)]),
];
const results = [];
for (const name of names) {
  if (!/^mandaria_c4_(clean|upgrade|reg)_[a-f0-9]+_test$/.test(name))
    throw Error('C4-owned isolated test database required');
  const u = new URL(source);
  u.pathname = '/' + name;
  const p = new PrismaClient({ datasourceUrl: u.toString() });
  try {
    // All rows here were created by this CHECK, in new databases. Preserve business
    // history, balances and test outcomes; only retire synthetic access/capacity.
    const credentials = await p.integrationCredential.updateMany({
      where: { status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    const users = await p.user.updateMany({
      where: { active: true },
      data: { active: false },
    });
    const zones = await p.serviceZone.updateMany({
      where: { status: 'ACTIVE' },
      data: { status: 'INACTIVE' },
    });
    const providers = await p.deliveryProvider.updateMany({
      where: { status: { not: 'SUSPENDED' } },
      data: { status: 'SUSPENDED' },
    });
    const [connections] =
      await p.$queryRaw`SELECT count(*)::int AS otherConnections FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`;
    results.push({
      database: name,
      credentialsRevoked: credentials.count,
      usersDisabled: users.count,
      zonesDisabled: zones.count,
      providersSuspended: providers.count,
      activeCredentialsRemaining: await p.integrationCredential.count({
        where: { status: 'ACTIVE' },
      }),
      connections,
      retained: {
        requests: await p.deliveryRequest.count(),
        authorizations: await p.authorizedQuoteAcceptance.count(),
        ledger: await p.creditLedgerEntry.count(),
      },
    });
  } finally {
    await p.$disconnect();
  }
}
writeFileSync(
  'docs/checks/v1.13-c4-cleanup.json',
  JSON.stringify(results, null, 2) + '\n',
);
console.log(
  JSON.stringify({ databases: results.length, historiesPreserved: true }),
);
