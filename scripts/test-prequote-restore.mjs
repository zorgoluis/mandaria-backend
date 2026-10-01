// Isolated local PostgreSQL regression. Never reads .env or DATABASE_URL.
// Usage: node scripts/test-prequote-restore.mjs <PostgreSQL bin directory>
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

const bin = process.argv[2];
if (!bin) throw new Error('Pass the local PostgreSQL bin directory');
const root = mkdtempSync(join(tmpdir(), 'mandaria-restore-regression-'));
const data = join(root, 'data');
const suffix = process.platform === 'win32' ? '.exe' : '';
const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG')));
function run(name, args, input, expected = 0) {
  const r = spawnSync(join(bin, name + suffix), args, { input, encoding: 'utf8', env, timeout: 120000,
    ...(name === 'pg_ctl' ? { stdio: 'ignore' } : {}) });
  if (r.error) throw r.error;
  assert.equal(r.status, expected, `${name}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}
const connection = ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres'];
const sql = (database, input) => run('psql', [...connection, '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-d', database], input);
let started = false;
try {
  run('initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '--encoding=UTF8', '--no-locale']);
  run('pg_ctl', ['-D', data, '-l', join(root, 'server.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']);
  started = true;
  sql('postgres', 'CREATE DATABASE source; CREATE DATABASE restored;');
  const historical = readFileSync('prisma/migrations/20260928000100_prequote_persistence/migration.sql', 'utf8');
  const functions = historical.slice(historical.indexOf('CREATE FUNCTION prequote_canonical_json'), historical.indexOf('ALTER TABLE "DeliveryPrequote" ADD CONSTRAINT "Prequote_conditions"'));
  sql('source', functions);
  const fixture = JSON.stringify({ conditionsVersion: 1, serviceType: 'LOCAL_DELIVERY', stops: [
    { type: 'PICKUP', sequence: 1, latitude: 16.75, longitude: -93.11 },
    { type: 'DROPOFF', sequence: 2, latitude: 16.76, longitude: -93.12 },
  ], packages: [{ category: 'FOOD', quantity: 1, isFragile: false, weightKg: null, lengthCm: null, widthCm: null, heightCm: null }] });
  const literal = `'${fixture}'::jsonb`;
  assert.equal(sql('source', `SET search_path=''; SELECT public.prequote_conditions_valid(${literal});`).split('\n').at(-1), 'f');
  console.log('PASS: reproduced historical failure with empty search_path');
  sql('source', `CREATE TABLE public."DeliveryPrequote" (conditions jsonb NOT NULL, CONSTRAINT "Prequote_conditions" CHECK (public.prequote_conditions_valid(conditions))); INSERT INTO public."DeliveryPrequote" VALUES (${literal});`);
  sql('source', readFileSync('prisma/migrations/20261001000100_prequote_restore_search_path/migration.sql', 'utf8'));
  assert.equal(sql('source', `SET search_path=''; SELECT public.prequote_conditions_valid(${literal});`).split('\n').at(-1), 't');
  console.log('PASS: migration validates existing conditions with empty search_path');
  const dump = join(root, 'fixture.dump');
  run('pg_dump', [...connection, '-d', 'source', '-Fc', '-f', dump]);
  run('pg_restore', [...connection, '-d', 'restored', '--exit-on-error', '--single-transaction', dump]);
  assert.equal(sql('restored', 'SELECT count(*) FROM public."DeliveryPrequote";'), '1');
  assert.equal(sql('source', 'SELECT conditions::text FROM public."DeliveryPrequote";'), sql('restored', 'SELECT conditions::text FROM public."DeliveryPrequote";'));
  console.log('PASS: unmodified custom dump restores normally and preserves the row');
  sql('restored', `SET search_path=''; DO $$ BEGIN
    BEGIN
      INSERT INTO public."DeliveryPrequote" VALUES (jsonb_set(${literal}, '{packages,0,quantity}', '0'));
      RAISE EXCEPTION 'Invalid conditions unexpectedly accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END $$;`);
  console.log('PASS: restored CHECK still rejects invalid conditions');
} finally {
  if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
  console.log(`Isolated test artifacts: ${root}`);
}
