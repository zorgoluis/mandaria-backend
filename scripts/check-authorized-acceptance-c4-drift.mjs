import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const source = new URL(process.env.TEST_DATABASE_URL);
const state = JSON.parse(readFileSync('.tmp/c4/databases.json'));
if (!['localhost', '127.0.0.1'].includes(source.hostname))
  throw Error('Local only');
const outputs = [];
const safe = (text) =>
  String(text).replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[DATABASE_URL]');
for (const name of Object.values(state)) {
  if (!/^mandaria_c4_(clean|upgrade)_[a-f0-9]+_test$/.test(name))
    throw Error('C4 database required');
  const u = new URL(source);
  u.pathname = '/' + name;
  const env = {
    ...process.env,
    TEST_DATABASE_URL: u.toString(),
  };
  const steps = [];
  for (const args of [
    ['migrate', 'status', '--config', 'prisma.test.config.ts'],
    ['migrate', 'deploy', '--config', 'prisma.test.config.ts'],
    [
      'migrate',
      'diff',
      '--from-url',
      u.toString(),
      '--to-schema-datamodel',
      'prisma/schema.prisma',
      '--exit-code',
    ],
  ]) {
    const result = spawnSync(
      process.execPath,
      ['node_modules/prisma/build/index.js', ...args],
      { env, encoding: 'utf8', maxBuffer: 20e6 },
    );
    const log = `docs/checks/v1.13-c4-${name}-${args[1]}.txt`;
    writeFileSync(log, safe((result.stdout || '') + (result.stderr || '')));
    steps.push({
      command: safe(
        ['node', 'node_modules/prisma/build/index.js', ...args].join(' '),
      ),
      exit: result.status,
      signal: result.signal,
      log,
    });
    assert.equal(result.status, 0, args[1]);
  }
  const p = new PrismaClient({ datasourceUrl: u.toString() });
  try {
    const [db] = await p.$queryRaw`SELECT version() AS version`;
    const migrations =
      await p.$queryRaw`SELECT migration_name,finished_at IS NOT NULL AS applied FROM "_prisma_migrations" ORDER BY migration_name`;
    const catalog =
      await p.$queryRaw`SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace='public'::regnamespace ORDER BY c.relname,t.tgname`;
    assert.ok(catalog.every((t) => t.tgenabled === 'O'));
    assert.ok(!catalog.some((t) => t.tgname.startsWith('C4_')));
    outputs.push({
      database: name,
      version: db.version,
      migrations,
      steps,
      triggerCount: catalog.length,
      catalogHash: createHash('sha256')
        .update(JSON.stringify(catalog))
        .digest('hex'),
    });
  } finally {
    await p.$disconnect();
  }
}
assert.equal(outputs[0].catalogHash, outputs[1].catalogHash);
writeFileSync(
  'docs/checks/v1.13-c4-migrations-final.json',
  JSON.stringify(outputs, null, 2) + '\n',
);
console.log(
  JSON.stringify(
    outputs.map(({ database, triggerCount, catalogHash }) => ({
      database,
      triggerCount,
      catalogHash,
    })),
  ),
);
