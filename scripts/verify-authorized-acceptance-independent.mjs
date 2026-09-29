import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const source = new URL(process.env.TEST_DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(source.hostname))
  throw Error('Local required');
const name = `mandaria_c2_independent_${randomBytes(5).toString('hex')}_test`;
source.pathname = '/postgres';
const admin = new PrismaClient({ datasourceUrl: source.toString() });
try {
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
} finally {
  await admin.$disconnect();
}
source.pathname = '/' + name;
const steps = [];
for (const [label, args] of [
  [
    'migrate',
    [
      'node_modules/prisma/build/index.js',
      'migrate',
      'deploy',
      '--config',
      'prisma.test.config.ts',
    ],
  ],
  [
    'independent full file',
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      'vitest.config.e2e.ts',
      'test/independent-drivers.e2e-spec.ts',
      '--pool=forks',
      '--reporter=default',
      '--reporter=json',
      '--outputFile=docs/checks/v1.13-c2-independent-isolated.json',
    ],
  ],
]) {
  const r = spawnSync(process.execPath, args, {
    env: { ...process.env, TEST_DATABASE_URL: source.toString() },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  steps.push({
    label,
    command: ['node', ...args].join(' '),
    exit: r.status,
    signal: r.signal,
  });
  console.log(label, r.status, r.stdout || '', r.stderr || '');
  writeFileSync(
    'docs/checks/v1.13-c2-independent-isolation.json',
    JSON.stringify({ database: name, steps }, null, 2) + '\n',
  );
  assert.equal(r.status, 0, label);
}
